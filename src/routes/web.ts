import { registerAuthRoutes, requestEmailChange } from './auth.js';
import {config} from '../config.js';
import {isLocale} from '../i18n.js';
import {requestLocale,saveLocale,localeReturnTo} from '../services/locale.js';
import type { FastifyInstance } from 'fastify';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { exec, nowString, queryOne } from '../db.js';
import {
  findUserByEmail,
  registerUser,
  checkUserPassword,
  changeUserPassword,
  signUser,
  isAdmin,
  PERMISSION_BANNED,
} from '../services/user.js';
import { addPlayer, renamePlayer, deletePlayer, listPlayersOfUser, countPlayersOfUser, findPlayerByName } from '../services/player.js';
import { closetOf, closetAdd, closetRemove, closetRename, findTextureByTid, uploadTexture, skinlibSearch, getDescription, setDescription, deleteTexture } from '../services/texture.js';
import { getOption, getOptionBool, getOptionInt, getOptionLocalized, setOption } from '../services/option.js';
import { hashPassword, needsRehash } from '../services/cipher.js';
import { loadProviders, identitiesOf, type OAuthProviderConfig } from '../services/oauth-client.js';
import { verifyOauthState, oauthState, csrfToken } from '../services/session.js';
import { revokeAllTokensForUser } from '../services/token.js';
import { getUuidByName, normalizeUuid } from '../services/uuid.js';
import { verificationOf,mojangConfiguration } from '../services/mojang.js';
import { loginMethods } from '../services/login-methods.js';
import { randomToken } from '../util.js';
import { sendMail, mailConfigured } from '../services/mail.js';
import { appearanceSettings, HOME_LAYOUTS, PALETTES, RADIUS_PRESETS, isHomeLayout, parseAppearance, saveAppearance, themeContext } from '../services/theme.js';
import { pageNumber, siteChart, siteSummary } from '../services/site-data.js';
import { descriptionLimit, renderMarkdown } from '../services/content.js';
import { pluginEnabled } from '../services/plugins.js';
import {compileSearch,SearchError} from '../services/search.js';

/**
 * Server-rendered pages: home, auth, user center, skinlib, admin.
 */
export async function registerWebRoutes(app: FastifyInstance): Promise<void> {
  const view = async (request: any) => {
    const user = request.currentUser;
    const darkMode = user?.is_dark_mode === 1;
    const locale = requestLocale(request);
    return {
      ...(await themeContext()),
      user: user ? { uid: user.uid, email: user.email, nickname: user.nickname, score: user.score, permission: user.permission, avatar: user.avatar, locale: user.locale, verified: !!user.verified, isDarkMode: darkMode } : null,
      hasPassword: !!user?.password,
      hideAdvancedMenu: await pluginEnabled('hide-advanced-menu'),
      hitokotoEnabled: await pluginEnabled('hitokoto'),
      isAdmin: isAdmin(user),
      siteName: await getOptionLocalized('site_name', locale),
      siteUrl: await getOption('site_url', ''),
      siteDescription: await getOptionLocalized('site_description', locale),
      announcementHtml: sanitizeHtml(marked.parse((await getOptionLocalized('announcement', locale)) || '', { async: false }) as string),
      copyrightText: sanitizeHtml(await getOption('copyright_text', '')),
      oauthProviders: await publicProviders(),
      localLoginEnabled: await getOptionBool('local_login_enabled', true),
      csrf: csrfToken(request.session),
      currentPath: request.url.split('?')[0],
      darkMode,
      locale,
      localeReturnTo:localeReturnTo(request.url),
      htmlLang: locale === 'en' ? 'en' : 'zh-CN',
      customCss: await getOption('custom_css', ''),
      customJs: await getOption('custom_js', ''),
      faviconUrl: await getOption('favicon_url', '/favicon.ico'),
      recaptchaSiteKey: await getOption('recaptcha_sitekey',''),
      recaptchaInvisible:await getOptionBool('recaptcha_invisible',false),
      t: (key: string) => request.t(key),
    };
  };

  app.post('/locale',async(request,reply)=>{
    const body=request.body as Record<string,string>|undefined;
    const wantsJson=request.headers.accept?.includes('application/json');
    const reject=async(status:number,key:string)=>{
      const message=request.t(key);
      return wantsJson?reply.code(status).send({code:1,message}):reply.code(status).view('auth/notice',{...(await view(request)),message});
    };
    if(!request.checkCsrf(body?.csrf??request.headers['x-csrf-token'] as string))return reject(403,'locale.session-expired');
    if(!isLocale(body?.locale))return reject(422,'locale.invalid');
    await saveLocale(request,reply,body.locale);
    const redirect=localeReturnTo(body.redirect);
    return wantsJson?{code:0,locale:body.locale,redirect}:reply.redirect(redirect,303);
  });

  // --- Home -----------------------------------------------------------------
  app.get('/', async (request, reply) => {
    const base = await view(request);
    const homePicUrl = await getOption('home_pic_url', '');
    const preview = (request.query as any)?.layout_preview;
    const homeLayout = base.isAdmin && isHomeLayout(preview) ? preview : base.appearance.home_layout;
    const recent = await skinlibSearch({ page: 1, perPage: homeLayout === 'gallery' ? 12 : 6, status: 'public', sort: 'time' });
    return reply.view('home', {
      ...base,
      title: '',
      homePicUrl,
      recentTextures: recent.items,
      homeLayout,
      showRecent: base.appearance.home_show_recent === 'true',
      previewLayout: base.isAdmin && isHomeLayout(preview),
      fixedBg: (await getOption('fixed_bg', 'false')) === 'true',
      hideIntro: (await getOption('hide_intro', 'false')) === 'true',
      transparentNavbar: (await getOption('transparent_navbar', 'false')) === 'true',
    });
  });

  await registerAuthRoutes(app, view);

  // UUID details are fetched only after the owner explicitly reveals or copies them.
  app.get('/user/privacy/uuid', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Cookie');
    const user = request.currentUser;
    if (!user) return reply.code(401).send({code:1,message:'请先登录'});
    const query = request.query as Record<string, string>;
    let uuid: string | null = null;
    if (query.source === 'mojang') {
      const row = await verificationOf(user.uid);
      uuid = row?.verified ? normalizeUuid(row.uuid) : null;
    } else {
      const pid = Number(query.player);
      if (!Number.isSafeInteger(pid) || pid <= 0) return reply.code(400).send({code:1,message:'角色参数无效'});
      const player = await queryOne<{name:string}>('SELECT name FROM players WHERE pid=? AND uid=?', [pid,user.uid]);
      if (player) uuid = await getUuidByName(player.name);
    }
    if (!uuid) return reply.code(404).send({code:1,message:'未找到 UUID'});
    return {uuid};
  });

  // --- User center ---------------------------------------------------------------
  app.get('/user', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login?redirect=/user');
    const base = await view(request);
    const uid = base.user!.uid;
    const players = await listPlayersOfUser(uid);
    const playerData = await Promise.all(
      players.map(async (p) => ({
        pid: p.pid,
        name: p.name,
        skinTid: p.tid_skin > 0 ? p.tid_skin : null,
        capeTid: p.tid_cape > 0 ? p.tid_cape : null,
        skinHash: p.tid_skin > 0 ? (await findTextureByTid(p.tid_skin))?.hash ?? null : null,
        capeHash: p.tid_cape > 0 ? (await findTextureByTid(p.tid_cape))?.hash ?? null : null,
        model: p.tid_skin > 0 ? ((await findTextureByTid(p.tid_skin))?.type === 'alex' ? 'slim' : 'default') : 'default',
        uuid: await getUuidByName(p.name),
      }))
    );
    const user = request.currentUser;
    const canSign = !signedToday(user!.last_sign_at);
    const hasPassword = !!user!.password;
    const [verification,verificationSettings,verificationReward]=await Promise.all([verificationOf(user!.uid),mojangConfiguration(),getOptionInt('mojang_verification_score_award',0)]);
    return reply.view('user/index', { ...base, players: playerData, canSign, hasPassword,
      launcherApiRoot:(config.publicOrigin||base.siteUrl||`${request.protocol}://${request.headers.host}`).replace(/\/+$/,'')+'/api/yggdrasil',
      minecraftVerified:!!verification?.verified,minecraftVerificationConfigured:verificationSettings.configured,minecraftVerificationReward:Math.max(0,verificationReward),
      scoreRuleMin: (await getOption('sign_score', '10,100')).split(',')[0], scoreRuleMax: (await getOption('sign_score', '10,100')).split(',')[1] ?? (await getOption('sign_score', '10,100')).split(',')[0] });
  });

  app.post('/user/sign', async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ code: 1, message: '请先登录' });
    if (!request.checkCsrf((request.body as any)?.csrf ?? request.headers['x-csrf-token'] as string)) return reply.code(403).send({ code: 1, message: '会话已过期' });
    const user = request.currentUser;
    const result = await signUser(user);
    if (!result.ok) return reply.code(400).send({ code: 1, message: '今天已经签到过了' });
    return { code: 0, acquired: result.acquired, message: `签到成功,获得 ${result.acquired} 积分` };
  });

  // Navbar dark-mode toggle (legacy /toggle-dark-mode behaviour).
  app.post('/user/dark-mode', async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ code: 1, message: '请先登录' });
    if (!request.checkCsrf((request.body as any)?.csrf)) return reply.code(403).send({ code: 1, message: '会话已过期' });
    const next = request.currentUser.is_dark_mode === 1 ? 0 : 1;
    await exec('UPDATE users SET is_dark_mode = ? WHERE uid = ?', [next, request.currentUser.uid]);
    return { code: 0, dark: next === 1 };
  });

  app.get('/user/profile', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    return reply.view('user/profile', { ...(await view(request)), error: null, providers: await loadProviders() });
  });

  app.post('/user/profile', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return reply.code(403).view('error', { ...(await view(request)), title: '认证', code: 403, message: '会话已过期，请刷新页面后重试' });
    const uid = request.currentUser.uid;
    const action = body.action;
    if (action === 'nickname') {
      if ((await getOption('plugins_enabled', '')).includes('single-player-limit')) return reply.code(403).view('user/profile', { ...(await view(request)), error: '单角色模式下，昵称随角色名同步修改', providers: await loadProviders() });
      const nickname = String(body.nickname ?? '').trim().slice(0, 50);
      await exec('UPDATE users SET nickname = ? WHERE uid = ?', [nickname || request.currentUser.email.split('@')[0], uid]);
    } else if (action === 'password') {
      const current = String(body.current_password ?? '');
      const next = String(body.password ?? '');
      if (request.currentUser.password && !checkUserPassword(request.currentUser, current)) {
        return reply.view('user/profile', { ...(await view(request)), error: '当前密码不正确', providers: await loadProviders() });
      }
      if (next.length < 8 || Buffer.byteLength(next) > 72) {
        return reply.view('user/profile', { ...(await view(request)), error: '新密码长度至少为 8 位', providers: await loadProviders() });
      }
      await changeUserPassword(uid, next);
      await request.setSession(uid);
    } else if (action === 'email') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (request.currentUser.password && !checkUserPassword(request.currentUser, String(body.current_password || ''))) return reply.code(403).view('user/profile', { ...(await view(request)), error: '修改邮箱需要输入当前密码', providers: await loadProviders() });
      const dup = await findUserByEmail(email);
      if (dup && dup.uid !== uid) {
        return reply.view('user/profile', { ...(await view(request)), error: '该邮箱已被其他账户使用', providers: await loadProviders() });
      }
      const sent = await requestEmailChange(uid, email);
      return reply.view('auth/notice', { ...(await view(request)), message: sent ? '验证邮件已发送至新邮箱，确认后生效' : '邮箱格式无效或邮件服务不可用，请联系管理员' });
    } else if (action === 'locale') {
      await saveLocale(request,reply,body.locale==='en'?'en':'zh_CN');
      if(body.dark_mode!==undefined)await exec('UPDATE users SET is_dark_mode=? WHERE uid=?',[body.dark_mode==='1'?1:0,uid]);
    } else if (action === 'avatar') {
      const avatarTid = parseInt(body.avatar ?? '0', 10) || 0;
      if (avatarTid > 0) {
        const texture = await findTextureByTid(avatarTid);
        if (!texture || !['steve','alex'].includes(texture.type) || (texture.uploader !== uid && !texture.public)) {
          return reply.view('user/profile', { ...(await view(request)), error: '头像材质无效', providers: await loadProviders() });
        }
      }
      await exec('UPDATE users SET avatar = ? WHERE uid = ?', [avatarTid, uid]);
    }
    return reply.redirect('/user/profile');
  });

  // --- Players ------------------------------------------------------------------------
  app.get('/user/player', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    const base = await view(request);
    const players = await listPlayersOfUser(base.user!.uid);
    const closet = await closetOf(base.user!.uid);
    const playerData = await Promise.all(
      players.map(async (p) => ({
        pid: p.pid,
        name: p.name,
        skinTid: p.tid_skin > 0 ? p.tid_skin : null,
        capeTid: p.tid_cape > 0 ? p.tid_cape : null,
        skinHash: p.tid_skin > 0 ? (await findTextureByTid(p.tid_skin))?.hash ?? null : null,
        model: p.tid_skin > 0 ? ((await findTextureByTid(p.tid_skin))?.type === 'alex' ? 'slim' : 'default') : 'default',
        uuid: await getUuidByName(p.name),
      }))
    );
    const playerPreviews = await Promise.all(playerData.map(async p => ({ ...p, capeHash: p.capeTid ? (await findTextureByTid(p.capeTid))?.hash ?? null : null })));
    return reply.view('user/players', { ...base, players: playerPreviews, closet, scorePerPlayer: await getOption('score_per_player', '100') });
  });

  app.get('/user/closet', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    const base = await view(request);
    const players = await listPlayersOfUser(base.user!.uid);
    const closet = await closetOf(base.user!.uid);
    const q = request.query as Record<string,string>, page = pageNumber(q.page);
    const keyword = String(q.q ?? '').trim().slice(0,100), type = ['skin','cape','steve','alex'].includes(q.type) ? q.type : '';
    const filtered = closet.filter(item => (!type || item.type === type || type === 'skin' && item.type !== 'cape') && (!keyword || item.item_name.toLowerCase().includes(keyword.toLowerCase())));
    return reply.view('user/closet', { ...base, closet:filtered.slice((page - 1) * 20,page * 20), players,total:filtered.length,page,pages:Math.max(1,Math.ceil(filtered.length / 20)),keyword,type });
  });

  app.get('/user/connections', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    const base = await view(request);
    const grants = (await import('../services/oidc.js')).findExistingGrant;
    void grants;
    const rows = (await import('../db.js')).query as any;
    const grantRows = await rows('SELECT id, payload FROM yggc_grants');
    const clients = new Map<number, { id: number; name: string }>();
    const grantsOfUser: any[] = [];
    for (const row of grantRows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (Number(payload?.accountId) !== base.user!.uid) continue;
      const clientId = parseInt(payload.clientId, 10);
      if (!clients.has(clientId)) {
        const client = await queryOne('SELECT id, name FROM oauth_clients WHERE id = ?', [clientId]);
        if (client) clients.set(clientId, client as { id: number; name: string });
      }
      if (clients.has(clientId)) {
        grantsOfUser.push({ grantId: row.id, client: clients.get(clientId), scopes: payload.scopes ?? [], grantedAt: payload.iat });
      }
    }
    const methods = await loginMethods(base.user!.uid,request.currentUser!.password);
    return reply.view('user/connections', { ...base, grants: grantsOfUser, identities: methods.identities.map(identity=>({...identity,canUnlink:methods.canUnlink(identity.provider)})), providers: await loadProviders() });
  });

  // --- Skin library --------------------------------------------------------------
  app.get('/skinlib', async (request, reply) => {
    const base = await view(request);
    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const requestedType = query.type ?? query.filter;
    const type = (['steve', 'alex', 'cape', 'skin'].includes(requestedType ?? '') ? requestedType : undefined) as any;
    const sort = (['time', 'likes', 'tid'].includes(query.sort ?? '') ? query.sort : 'time') as any;
    const status = (['public', 'private'].includes(query.status ?? '') ? query.status : undefined) as any;
    const result = await skinlibSearch({
      keyword: query.keyword?.slice(0, 100),
      type,
      sort,
      status,
      uploader: Number.isSafeInteger(Number(query.uploader)) && Number(query.uploader) > 0 ? Number(query.uploader) : undefined,
      page,
      perPage: 24,
      viewer: base.user ? { uid: base.user.uid, admin: base.isAdmin } : null,
    });
    const items = result.items.map((item) => ({
      tid: item.tid,
      name: item.name,
      type: item.type,
      hash: item.hash,
      public: item.public === 1,
      likes: item.likes,
      uploader: item.uploader,
      nickname: (item as any).nickname,
    }));
    return reply.view('skinlib/index', {
      ...base,
      items,
      total: result.total,
      page,
      pages: Math.max(1, Math.ceil(result.total / 24)),
      filters: { keyword: query.keyword ?? '', type: type ?? '', sort: sort ?? 'time', status: status ?? '', uploader: query.uploader ?? '' },
    });
  });

  app.get('/skinlib/upload', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login?redirect=/skinlib/upload');
    const base = await view(request);
    return reply.view('skinlib/upload', {
      ...base,
      scorePerStorage: await getOptionInt('score_per_storage', 3),
      privateScorePerStorage: await getOptionInt('private_score_per_storage', 25),
      closetItemCost: await getOptionInt('score_per_closet_item', 2),
      maxFileSize: await getOptionInt('max_upload_file_size', 1024),
      award: await getOptionInt('score_award_per_texture', 0),
      descriptionMaxLength: await descriptionLimit(),
      contentPolicyHtml: renderMarkdown(await getOption('content_policy','')),
    });
  });

  app.get('/skinlib/show/:tid', async (request, reply) => {
    const { tid } = request.params as { tid: string };
    const texture = await findTextureByTid(parseInt(tid, 10));
    const base = await view(request);
    if (!texture) return reply.code(404).view('error', { ...base, title: '错误', code: 404, message: '材质不存在' });
    const isOwner = base.user?.uid === texture.uploader;
    if (!texture.public && !isOwner && !base.isAdmin) {
      const statusCode = parseInt(await getOption('status_code_for_private', '403'), 10) || 403;
      return reply.code(statusCode).view('error', { ...base, title: '错误', code: statusCode, message: '该材质为私有材质。' });
    }
    const description = await getDescription(texture.tid);
    const inCloset = base.user ? await queryOne('SELECT 1 FROM user_closet WHERE user_uid = ? AND texture_tid = ?', [base.user.uid, texture.tid]) : null;
    const players = base.user ? await listPlayersOfUser(base.user.uid) : [];
    return reply.view('skinlib/show', {
      ...base,
      texture: { ...texture, public: texture.public === 1 },
      isOwner,
      description,
      descriptionHtml: renderMarkdown(description),
      descriptionMaxLength: await descriptionLimit(),
      inCloset: !!inCloset,
      applyPlayers: players.map((p) => ({ pid: p.pid, name: p.name, applied: (texture.type === 'cape' ? p.tid_cape : p.tid_skin) === texture.tid })),
      allowDownload: await getOptionBool('allow_downloading_texture', false),
    });
  });

  // --- Admin ------------------------------------------------------------------------------
  app.get('/admin', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const [stats,chart] = await Promise.all([siteSummary(),siteChart()]);
    const lastLog = await (await import('../db.js')).query('SELECT * FROM ygg_log ORDER BY id DESC LIMIT 10');
    return reply.view('admin/index', { ...base, stats, chart, lastLog });
  });

  app.get('/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const query = request.query as Record<string, string>;
    const page = pageNumber(query.page),keyword=String(query.keyword??query.q??'').trim();
    let search;try{search=compileSearch('users',keyword,{numericIds:true,timezone:config.tz,defaultOrder:'`uid` ASC'});}catch(error){if(!(error instanceof SearchError))throw error;return reply.code(422).view('admin/users',{...base,users:[],total:0,page,pages:1,keyword,searchError:error.message});}
    const {where,params}=search;
    const total = (await queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM users ${where}`, params))?.c ?? 0;
    const users = await (await import('../db.js')).query(
      `SELECT uid, email, nickname, score, permission, verified, register_at, last_sign_at FROM users ${where} ORDER BY ${search.orderBy} LIMIT 20 OFFSET ?`,
      [...params, (page - 1) * 20]
    );
    return reply.view('admin/users', { ...base, users, total, page, pages: Math.max(1, Math.ceil(total / 20)), keyword,searchError:null });
  });

  app.get('/admin/players', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const query = request.query as Record<string, string>;
    const page = pageNumber(query.page),keyword=String(query.keyword??query.q??'').trim();
    let search;try{search=compileSearch('players',keyword,{alias:'p',numericIds:true,timezone:config.tz,defaultOrder:'p.pid ASC'});}catch(error){if(!(error instanceof SearchError))throw error;return reply.code(422).view('admin/players',{...base,players:[],total:0,page,pages:1,keyword,searchError:error.message});}
    const {where,params}=search;
    const total = (await queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM players p ${where}`, params))?.c ?? 0;
    const players = await (await import('../db.js')).query(
      `SELECT p.*, u.email FROM players p LEFT JOIN users u ON u.uid = p.uid ${where} ORDER BY ${search.orderBy} LIMIT 20 OFFSET ?`,
      [...params, (page - 1) * 20]
    );
    return reply.view('admin/players', { ...base, players, total, page, pages: Math.max(1, Math.ceil(total / 20)), keyword,searchError:null });
  });

  app.get('/admin/textures', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const result = await skinlibSearch({
      keyword: query.keyword?.slice(0, 100),
      type: ['skin','steve','alex','cape'].includes(query.type) ? query.type as any : undefined,
      sort: ['time','likes','tid'].includes(query.sort) ? query.sort as any : 'time',
      status: ['public','private'].includes(query.status) ? query.status as any : undefined,
      uploader: Number.isSafeInteger(Number(query.uploader)) && Number(query.uploader) > 0 ? Number(query.uploader) : undefined,
      page,
      perPage: 20,
      viewer: { uid: base.user!.uid, admin: true },
    });
    return reply.view('admin/textures', { ...base, items: result.items, total: result.total, page, pages: Math.max(1, Math.ceil(result.total / 20)), filters: { keyword: query.keyword ?? '', type: query.type ?? '', sort: query.sort ?? 'time', status: query.status ?? '', uploader: query.uploader ?? '' } });
  });

  app.get('/admin/reports', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const query=request.query as Record<string,string>,keyword=String(query.keyword??query.q??'').trim(),page=pageNumber(query.page);
    let search;try{search=compileSearch('reports',keyword,{alias:'r',numericIds:true,timezone:config.tz,defaultOrder:'r.status ASC, r.id DESC'});}catch(error){if(!(error instanceof SearchError))throw error;return reply.code(422).view('admin/reports',{...base,reports:[],total:0,page,pages:1,keyword,searchError:error.message});}
    const total=(await queryOne<{c:number}>(`SELECT COUNT(*) AS c FROM reports r ${search.where}`,search.params))?.c??0;
    const reports = await (await import('../db.js')).query(
      `SELECT r.*, t.name AS texture_name, t.hash FROM reports r LEFT JOIN textures t ON t.tid = r.tid ${search.where} ORDER BY ${search.orderBy} LIMIT 20 OFFSET ?`,[...search.params,(page-1)*20]
    );
    return reply.view('admin/reports', { ...base, reports,total,page,pages:Math.max(1,Math.ceil(total/20)),keyword,searchError:null });
  });

  app.get('/admin/clients', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const clients = await (await import('../db.js')).query('SELECT id, name, secret, redirect, revoked, created_at FROM oauth_clients ORDER BY id ASC');
    return reply.view('admin/clients', { ...base, clients, sharedClientId: await getOption('ygg_shared_client_id', ''), error: null });
  });

  app.post('/admin/clients', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return reply.code(403).send('CSRF 校验失败');
    const action = body.action;
    if (action === 'create') {
      const name = String(body.name ?? '').trim().slice(0, 100) || '未命名应用';
      const secret = body.public_client === '1' ? null : randomToken(48);
      const redirects = String(body.redirect ?? '')
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
      const { createClient } = await import('../services/oidc.js');
      await createClient({ name, secret, redirects, ownerId: base.user!.uid });
    } else if (action === 'delete') {
      const id = parseInt(body.client_id ?? '0', 10);
      await exec('UPDATE oauth_clients SET revoked = 1 WHERE id = ?', [id]);
      await exec('UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0', [id]);
    } else if (action === 'set_shared') {
      await setOption('ygg_shared_client_id', String(body.shared_client_id ?? '').trim());
    }
    return reply.redirect('/admin/clients');
  });

  app.get('/admin/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const keys = [
      'site_name', 'site_url', 'site_description', 'announcement', 'copyright_text',
      'player_name_rule', 'player_name_length_min', 'player_name_length_max', 'custom_player_name_regexp',
      'register_with_player_name', 'local_login_enabled', 'regs_per_ip', 'require_verification', 'user_initial_score','recaptcha_sitekey','recaptcha_invisible',
      'score_per_player', 'score_per_storage', 'private_score_per_storage', 'score_per_closet_item',
      'score_award_per_texture', 'take_back_scores_after_deletion', 'status_code_for_private', 'return_score', 'score_award_per_like', 'reporter_score_modification', 'reporter_reward_score', 'sign_after_zero', 'content_policy',
      'allow_downloading_texture', 'max_upload_file_size', 'sign_score', 'sign_gap_time', 'textures_description_limit',
      'ygg_uuid_algorithm', 'ygg_token_expire_1', 'ygg_token_expire_2', 'ygg_tokens_limit',
      'ygg_search_profile_max', 'ygg_skin_domain', 'ygg_disable_authserver',
      'ygg_connect_server_url', 'ygg_shared_client_id', 'yggc_device_code_expire',
    ];
    const values: Record<string, string> = {};
    for (const key of keys) values[key] = (await getOption(key)) ?? '';
    return reply.view('admin/settings', {
      ...base, values,
      saved: (request.query as any)?.saved === '1',
      error: String((request.query as any)?.error ?? ''),
      providers: await loadProviders(),
      homeLayouts: HOME_LAYOUTS,
      palettes: PALETTES,
      radiusPresets: RADIUS_PRESETS,
      homePicture: await getOption('home_pic_url', ''),
      recaptchaConfigured:!!await getOption('recaptcha_secretkey',''),
      fixedBackground: await getOptionBool('fixed_bg', false),
      hideIntroduction: await getOptionBool('hide_intro', false),
      transparentNavigation: await getOptionBool('transparent_navbar', false),
    });
  });

  app.post('/admin/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return reply.code(403).send('CSRF 校验失败');
    if (body.action === 'appearance') {
      const next = parseAppearance(body, await appearanceSettings());
      const submittedPicture = String(body.home_pic_url || '').trim();
      const picture = submittedPicture.startsWith('//') ? 'https:' + submittedPicture : submittedPicture;
      let validPicture = !picture || (picture.startsWith('/') && !picture.startsWith('//') && !/[\\\s'"<>]/.test(picture));
      if (!validPicture) {
        try { const url = new URL(picture); validPicture = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\s'"<>]/.test(picture); } catch { /* invalid URL */ }
      }
      if (!next || !validPicture || picture.length > 2048) return reply.redirect('/admin/settings?error=appearance-invalid#appearance');
      await saveAppearance(next, { home_pic_url: picture, fixed_bg: body.fixed_bg === 'true' ? 'true' : 'false', hide_intro: body.hide_intro === 'true' ? 'true' : 'false', transparent_navbar: body.transparent_navbar === 'true' ? 'true' : 'false' });
      return reply.redirect('/admin/settings?saved=1#appearance');
    }
    if (body.action === 'providers') {
      let providers: OAuthProviderConfig[] = [];
      try {
        providers = JSON.parse(String(body.providers ?? '[]'));
      } catch {
        return reply.redirect('/admin/settings?error=providers-json#oauth');
      }
      if (!(await getOptionBool('local_login_enabled', true)) && providers.length === 0) {
        return reply.redirect('/admin/settings?error=local-login-required#oauth');
      }
      try {
        await (await import('../services/oauth-client.js')).saveProviders(providers);
      } catch {
        return reply.redirect('/admin/settings?error=providers-invalid#oauth');
      }
      return reply.redirect('/admin/settings?saved=1#oauth');
    }
    const allowed = new Set(['site_name','site_url','site_description','announcement','copyright_text','player_name_rule','player_name_length_min','player_name_length_max','custom_player_name_regexp','register_with_player_name','local_login_enabled','regs_per_ip','require_verification','user_initial_score','score_per_player','score_per_storage','private_score_per_storage','score_per_closet_item','score_award_per_texture','score_award_per_like','reporter_score_modification','reporter_reward_score','return_score','take_back_scores_after_deletion','status_code_for_private','allow_downloading_texture','max_upload_file_size','sign_score','sign_gap_time','sign_after_zero','ygg_uuid_algorithm','ygg_token_expire_1','ygg_token_expire_2','ygg_tokens_limit','ygg_search_profile_max','ygg_skin_domain','ygg_disable_authserver','ygg_shared_client_id','yggc_device_code_expire','content_policy']);
    allowed.add('textures_description_limit');
    if (body.textures_description_limit !== undefined && (!/^\d+$/.test(body.textures_description_limit) || Number(body.textures_description_limit) > 65535)) return reply.redirect('/admin/settings?error=description-limit');
    const localLoginNext = body.local_login_enabled === undefined
      ? await getOptionBool('local_login_enabled', true)
      : !['false', '0', ''].includes(String(body.local_login_enabled));
    if (!localLoginNext && (await loadProviders()).length === 0) {
      return reply.redirect('/admin/settings?error=local-login-required#oauth');
    }
    const editable = Object.keys(body).filter((k) => allowed.has(k));
    if(body.recaptcha_sitekey!==undefined){
      const sitekey=String(body.recaptcha_sitekey).trim(),secret=sitekey?(String(body.recaptcha_secretkey??'').trim()||await getOption('recaptcha_secretkey','')):'';
      if(sitekey&&(!secret||![sitekey,secret].every(value=>/^[A-Za-z0-9_-]{1,512}$/.test(value))))return reply.redirect('/admin/settings?error=recaptcha-invalid#register');
      await setOption('recaptcha_sitekey',sitekey);await setOption('recaptcha_secretkey',secret);
      const invisible=body.recaptcha_invisible===undefined?await getOptionBool('recaptcha_invisible',false):['true','1'].includes(String(body.recaptcha_invisible));
      await setOption('recaptcha_invisible',sitekey&&invisible?'true':'false');
    }
    for (const key of editable) {
      await setOption(key, key === 'local_login_enabled' ? (localLoginNext ? 'true' : 'false') : String(body[key] ?? ''));
    }
    return reply.redirect('/admin/settings?saved=1');
  });

  app.get('/admin/ygg-log', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const base = await view(request);
    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const total = (await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM ygg_log'))?.c ?? 0;
    const logs = await (await import('../db.js')).query(
      'SELECT * FROM ygg_log ORDER BY id DESC LIMIT 50 OFFSET ?',
      [(page - 1) * 50]
    );
    return reply.view('admin/ygg-log', { ...base, logs, total, page, pages: Math.max(1, Math.ceil(total / 50)) });
  });
}

function requireAdmin(request: any, reply: any): boolean {
  if (!request.currentUser) {
    reply.redirect('/auth/login?redirect=' + encodeURIComponent(request.url));
    return false;
  }
  if (request.currentUser.permission < 1) {
    reply.code(403).view('error', { title: '错误', code: 403, message: '需要管理员权限。' });
    return false;
  }
  return true;
}

function signedToday(lastSignAt: string): boolean {
  const today = new Date();
  const todayStr = today.toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Asia/Shanghai' });
  return lastSignAt.slice(0, 10) >= todayStr;
}

function safeRedirect(target: string | undefined): string {
  if (!target) return '';
  if (!target.startsWith('/') || target.startsWith('//')) return '';
  return target;
}

async function publicProviders(): Promise<Array<{ key: string; displayName: string }>> {
  const providers = await loadProviders();
  return providers.map((p) => ({ key: p.key, displayName: p.displayName }));
}
