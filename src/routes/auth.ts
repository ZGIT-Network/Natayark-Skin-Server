import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ResultSetHeader } from 'mysql2/promise';
import { config } from '../config.js';
import { exec, queryOne, transaction, nowString } from '../db.js';
import { findUserByEmail, findUserByUid, registerUser, registerUserInTransaction, checkUserPassword, changeUserPassword, PERMISSION_BANNED } from '../services/user.js';
import { getOption, getOptionBool } from '../services/option.js';
import { hashPassword, needsRehash } from '../services/cipher.js';
import { tokenHash, clearSessionCookie } from '../services/session.js';
import { findProvider, buildAuthorizeUrl, exchangeCode, createOAuthFlow, readOAuthFlow, findIdentity, linkIdentity, identitiesOf, type OAuthFlow } from '../services/oauth-client.js';
import { sendMail, mailConfigured } from '../services/mail.js';
import { validatePlayerName } from '../util.js';
import { loginMethods } from '../services/login-methods.js';
import { pluginEnabled } from '../services/plugins.js';
import { findPlayerByName } from '../services/player.js';
import {createCaptcha,verifyCaptcha,loginFailures,recordLoginFailure,clearLoginFailures} from '../services/captcha.js';

type View = (request: FastifyRequest) => Promise<Record<string, any>>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const textBody = (request: FastifyRequest): Record<string, string> => (request.body ?? {}) as Record<string, string>;
export function safeAuthRedirect(target?: string): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || /[\\\r\n\u0000-\u001f]/.test(target)) return '/user';
  return target;
}
async function origin(): Promise<string> {
  const value = config.publicOrigin || await getOption('site_url', 'http://localhost:3000');
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid public origin');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  return url.origin;
}
export async function registrationEnabled(): Promise<boolean> {
  return !await pluginEnabled('disable-registration');
}
export async function localLoginEnabled(): Promise<boolean> {
  return getOptionBool('local_login_enabled', true);
}
function emailValid(value: string): boolean { return value.length <= 100 && EMAIL.test(value); }
function failPage(reply: FastifyReply, base: Record<string, any>, message: string, code = 400): FastifyReply {
  return reply.code(code).view('error', { ...base, title: '认证', code, message });
}
async function sendChallenge(purpose: string, uid: number | null, email: string, payload: Record<string, unknown>): Promise<boolean> {
  if (!mailConfigured()) return false;
  const token = crypto.randomBytes(32).toString('base64url');
  if (uid !== null) await exec('DELETE FROM mcn_email_challenges WHERE purpose = ? AND user_id = ?', [purpose, uid]);
  await exec('INSERT INTO mcn_email_challenges (token_hash, purpose, user_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [tokenHash(token), purpose, uid, JSON.stringify(payload), nowString(), nowString(3600)]);
  const path = purpose === 'reset' ? '/auth/reset/' + uid + '?token=' : '/auth/verify-email?token=';
  const link = await origin() + path + encodeURIComponent(token);
  try {
    await sendMail(email, purpose === 'reset' ? '重置密码' : '验证邮箱',
      '<p>此链接在一小时内有效。若非本人操作，请忽略此邮件。</p><p><a href="' + link + '">' + link + '</a></p>');
    return true;
  } catch {
    await exec('DELETE FROM mcn_email_challenges WHERE token_hash = ?', [tokenHash(token)]);
    return false;
  }
}
async function challenge(token: string, purpose: string, uid?: number): Promise<any | null> {
  if (!token || token.length > 100) return null;
  return queryOne('SELECT * FROM mcn_email_challenges WHERE token_hash = ? AND purpose = ? AND expires_at > ?' + (uid === undefined ? '' : ' AND user_id = ?'),
    [tokenHash(token), purpose, nowString(), ...(uid === undefined ? [] : [uid])]);
}
async function completeOAuthRegistration(flowToken: string, sid: string): Promise<{ uid: number; redirect: string } | null> {
  return transaction(async conn => {
    const flow = await readOAuthFlow(flowToken, sid, 'pending', true);
    if (!flow?.remote || !flow.email || !flow.passwordHash || !(await registrationEnabled())) return null;
    const existing = await findIdentity(flow.provider, flow.remote.id);
    if (existing) throw new Error('此第三方身份已绑定账户，请重新登录');
    const result = await registerUserInTransaction(conn, {
      email: flow.email, nickname: flow.nickname || flow.remote.username, player_name: flow.playerName,
      verified: true, ip: flow.ip,
      share: flow.share,
    }, flow.passwordHash);
    if (!result.ok) throw new Error(result.code === 'dup_email' ? '该邮箱已经注册，请先登录原账户后绑定' : result.code === 'dup_player' ? '角色名已经被使用' : '注册信息无效');
    const linked = await linkIdentity(result.user.uid, flow.provider, flow.remote);
    if (!linked) throw new Error('第三方身份已绑定其他账户');
    return { uid: result.user.uid, redirect: flow.redirect };
  });
}
async function completeLegacyOAuth(flowToken: string, sid: string, passwordProof?:string): Promise<{uid:number;redirect:string}|null> {
  return transaction(async conn => {
    const flow=await readOAuthFlow(flowToken,sid,'legacy-link',true);
    if(!flow?.legacyUid||!flow.remote||!flow.email||!await findProvider(flow.provider))return null;
    const [rows]=await conn.query<any[]>('SELECT uid,email,permission,password FROM users WHERE uid=? FOR UPDATE',[flow.legacyUid]);
    const user=rows[0];
    if(!user||user.permission<0||user.email.trim().toLowerCase()!==flow.email)throw new Error('原账户状态或邮箱已变化，请重新授权');
    if(passwordProof!==undefined&&!checkUserPassword(user,passwordProof))throw new Error('原账户密码已变化，请重新验证');
    const identity=await findIdentity(flow.provider,flow.remote.id);
    if(identity&&identity.user_id!==user.uid)throw new Error('该第三方身份已绑定其他账户');
    if(!identity&&!await linkIdentity(user.uid,flow.provider,flow.remote))throw new Error('此账户已有该提供方的其他绑定，请使用原登录方式');
    return{uid:user.uid,redirect:flow.redirect};
  });
}
export async function registerAuthRoutes(app: FastifyInstance, view: View): Promise<void> {
  const guarded = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.route({method:['GET','POST'],url:'/auth/captcha',config:{rateLimit:{max:30,timeWindow:'1 minute'}},handler:async(request,reply)=>{
    if(!request.session)return reply.code(400).send({code:1,message:'请先打开登录页面'});
    return reply.header('Cache-Control','private, no-store').type('image/jpeg').send(await createCaptcha(request.session.sid));
  }});
  app.get('/auth/login', async (request, reply) => {
    if (request.currentUser) return reply.redirect(safeAuthRedirect((request.query as any).redirect));
    return reply.view('auth/login', { ...(await view(request)), error: null, redirect: safeAuthRedirect((request.query as any).redirect), registrationEnabled: await registrationEnabled(),captchaRequired:await loginFailures(request.ip)>3 });
  });
  app.post('/auth/login', guarded, async (request, reply) => {
    const body = textBody(request);
    const fail = async (message: string, code = 401) => reply.code(code).view('auth/login', {
      ...(await view(request)), error: message, redirect: safeAuthRedirect(body.redirect),
      email: String(body.identification ?? body.email ?? '').slice(0, 100),
      registrationEnabled: await registrationEnabled(),
      captchaRequired:await loginFailures(request.ip)>3,
    });
    if (!request.checkCsrf(body.csrf)) return fail('会话已过期，请刷新后重试', 403);
    if (!(await localLoginEnabled())) return fail('本站已关闭邮箱密码登录，请使用第三方账号登录', 403);
    if(await loginFailures(request.ip)>3&&(!request.session||!await verifyCaptcha(request.session.sid,body.captcha??body['g-recaptcha-response'],request.ip)))return fail('验证码不正确或已过期，请重新输入',422);
    const identification=String(body.identification??body.email??'').trim();
    const player=EMAIL.test(identification)?null:await findPlayerByName(identification);
    const user=EMAIL.test(identification)?await findUserByEmail(identification.toLowerCase()):player?await findUserByUid(player.uid):null;
    if (!user || user.permission === PERMISSION_BANNED || !checkUserPassword(user, String(body.password || ''))) {await recordLoginFailure(request.ip);return fail('账户或密码不正确');}
    await clearLoginFailures(request.ip);
    if (needsRehash(user.password)) await changeUserPassword(user.uid, body.password);
    await clearSessionCookie(reply, request);
    await request.setSession(user.uid,['1','true','on','yes'].includes(String(body.keep??body.remember??'')));
    return reply.redirect(safeAuthRedirect(body.redirect));
  });
  app.get('/auth/register', async (request, reply) => {
    if (request.currentUser) return reply.redirect('/user');
    if (!(await localLoginEnabled())) return reply.redirect('/auth/login');
    if (!(await registrationEnabled())) return failPage(reply, await view(request), '本站已关闭注册', 403);
    return reply.view('auth/register', { ...(await view(request)), error: null, share: String((request.query as any).share || '').slice(0, 255),
      registerWithPlayerName: await getOptionBool('register_with_player_name', true), regsPerIp: await getOption('regs_per_ip', '3') });
  });
  app.post('/auth/register', guarded, async (request, reply) => {
    const body = textBody(request), registerWithPlayerName = await getOptionBool('register_with_player_name', true);
    const fail = async (error: string, code = 400) => reply.code(code).view('auth/register', {
      ...(await view(request)), error, values: body,
      share: String(body.share || '').slice(0, 255), registerWithPlayerName,
      regsPerIp: await getOption('regs_per_ip', '3'),
    });
    if (!request.checkCsrf(body.csrf)) return fail('会话已过期，请刷新后重试', 403);
    if (!(await localLoginEnabled())) return reply.redirect('/auth/login');
    if (!(await registrationEnabled())) return fail('本站已关闭注册', 403);
    if(!request.session||!await verifyCaptcha(request.session.sid,body.captcha??body['g-recaptcha-response'],request.ip))return fail('验证码不正确或已过期，请重新输入',422);
    const password = String(body.password || ''), playerName = String(body.player_name || '').trim();
    if (password !== (body.password_confirm??body.password_confirmation)) return fail('两次密码不一致');
    if (password.length < 8 || password.length > 128 || Buffer.byteLength(password) > 72) return fail('密码为 8–72 字节');
    if (registerWithPlayerName && !validatePlayerName(playerName)) return fail('角色名不符合本站命名规则');
    const limit = Number(await getOption('regs_per_ip', '3'));
    const count = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE ip = ?', [request.ip]);
    if (Number.isFinite(limit) && (count?.c ?? 0) >= limit) return fail('当前 IP 的注册数量已达上限');
    const result = await registerUser({ email: String(body.email || ''), nickname: String(body.nickname || playerName),
      password, player_name: registerWithPlayerName ? playerName : undefined, ip: request.ip, share: String(body.share || '').slice(0, 255) });
    if (!result.ok) return fail(result.code === 'dup_email' ? '该邮箱已经注册' : result.code === 'dup_player' ? '角色名已经被使用' : '注册信息无效');
    if (!result.user.verified) await sendChallenge('verify', result.user.uid, result.user.email, {});
    await clearSessionCookie(reply, request);
    await request.setSession(result.user.uid);
    return reply.redirect('/user');
  });
  // GET is a confirmation page; only the CSRF-protected POST changes the session.
  app.get('/auth/logout', async (request, reply) => reply.view('auth/logout', await view(request)));
  app.post('/auth/logout', async (request, reply) => {
    if (!request.checkCsrf(textBody(request).csrf)) return failPage(reply, await view(request), '会话已过期', 403);
    await request.clearSession();
    return reply.redirect('/');
  });
  app.get('/auth/forgot', async (request, reply) => reply.view('auth/forgot', { ...(await view(request)), error: null, sent: false, mailConfigured: mailConfigured() }));
  app.post('/auth/forgot', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = textBody(request), base = await view(request);
    if (!request.checkCsrf(body.csrf)) return failPage(reply, base, '会话已过期', 403);
    if (!mailConfigured()) return reply.code(503).view('auth/forgot', { ...base, error: '邮件服务尚未配置，请联系站点管理员', sent: false, mailConfigured: false });
    if(!request.session||!await verifyCaptcha(request.session.sid,body.captcha??body['g-recaptcha-response'],request.ip))return reply.code(422).view('auth/forgot',{...base,error:'验证码不正确或已过期，请重新输入',sent:false,mailConfigured:true});
    const user = await findUserByEmail(String(body.email || '').trim().toLowerCase());
    if (user && user.permission !== PERMISSION_BANNED) {
      const recent = await queryOne('SELECT token_hash FROM mcn_email_challenges WHERE purpose = ? AND user_id = ? AND created_at > ?', ['reset', user.uid, nowString(-180)]);
      if (!recent) await sendChallenge('reset', user.uid, user.email, {});
    }
    return reply.view('auth/forgot', { ...base, error: null, sent: true, mailConfigured: true });
  });
  app.get('/auth/reset/:uid', async (request, reply) => {
    const uid = Number((request.params as any).uid), token = String((request.query as any).token || '');
    const valid = !!(await challenge(token, 'reset', uid));
    return reply.view('auth/reset', { ...(await view(request)), error: valid ? null : '重置链接无效或已过期', uid, token, valid });
  });
  app.post('/auth/reset/:uid', guarded, async (request, reply) => {
    const body = textBody(request), uid = Number((request.params as any).uid), token = String(body.token || '');
    const fail = async (message: string) => reply.code(400).view('auth/reset', { ...(await view(request)), error: message, uid, token, valid: false });
    if (!request.checkCsrf(body.csrf)) return fail('会话已过期，请刷新页面');
    if (!(await challenge(token, 'reset', uid))) return fail('重置链接无效或已过期');
    const password = String(body.password || '');
    if (password !== String(body.password_confirm ?? password)) return fail('两次密码不一致');
    if (password.length < 8 || Buffer.byteLength(password) > 72) return fail('密码为 8–72 字节');
    const passwordHash = await hashPassword(password);
    const success = await transaction(async conn => {
      const [rows] = await conn.query<any[]>('SELECT token_hash FROM mcn_email_challenges WHERE token_hash = ? AND purpose = ? AND user_id = ? AND expires_at > ? FOR UPDATE', [tokenHash(token), 'reset', uid, nowString()]);
      if (!rows.length) return false;
      await conn.query('DELETE FROM mcn_email_challenges WHERE purpose = ? AND user_id = ?', ['reset', uid]);
      await conn.query('UPDATE users SET password = ?, remember_token = NULL WHERE uid = ?', [passwordHash, uid]);
      await conn.query('DELETE FROM mcn_web_sessions WHERE user_id = ?', [uid]);
      await conn.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE user_id = ?', [uid]);
      await conn.query('UPDATE oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id = r.access_token_id SET r.revoked = 1 WHERE a.user_id = ?', [uid]);
      return true;
    });
    if (!success) return fail('重置链接无效或已过期');
    await request.clearSession();
    return reply.redirect('/auth/login');
  });
  async function beginOAuth(request: FastifyRequest, reply: FastifyReply, providerKey: string, linkUid?: number): Promise<FastifyReply> {
    const provider = await findProvider(providerKey);
    if (!provider || !request.session) return failPage(reply, await view(request), '登录方式不存在', 404);
    const verifier = crypto.randomBytes(48).toString('base64url');
    const redirectUri = await origin() + '/auth/login/' + encodeURIComponent(provider.key) + '/callback';
    const state = await createOAuthFlow(request.session.sid, 'authorize', { provider: provider.key, redirect: safeAuthRedirect((request.query as any).redirect), verifier, redirectUri, linkUid, share: String((request.query as any).share || '').slice(0, 255) });
    return reply.redirect(buildAuthorizeUrl(provider, redirectUri, state, verifier));
  }
  app.get('/auth/login/:provider', async (request, reply) => {
    if (request.currentUser) return reply.redirect('/user/connections');
    return beginOAuth(request, reply, (request.params as any).provider);
  });
  app.post('/user/connections/:provider/link', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    if (!request.checkCsrf(textBody(request).csrf)) return failPage(reply, await view(request), '会话已过期', 403);
    return beginOAuth(request, reply, (request.params as any).provider, request.currentUser.uid);
  });
  app.get('/auth/login/:provider/callback', async (request, reply) => {
    const query = request.query as Record<string, string>, key = (request.params as any).provider;
    const base = await view(request);
    const flow = request.session && await readOAuthFlow(query.state, request.session.sid, 'authorize', true);
    if (!flow || flow.provider !== key) return failPage(reply, base, 'OAuth 状态无效、已使用或已过期，请重新登录');
    if (query.error || !query.code) return failPage(reply, base, '授权已取消或未返回有效授权码');
    const provider = await findProvider(key);
    const remote = provider && await exchangeCode(provider, query.code, flow.redirectUri!, flow.verifier).catch(() => null);
    if (!remote) return failPage(reply, base, '未能从登录服务取得身份信息，请稍后重试', 502);
    const identity = await findIdentity(key, remote.id);
    if (flow.linkUid) {
      if (request.currentUser?.uid !== flow.linkUid) return failPage(reply, base, '绑定时的登录状态已失效，请重新操作', 403);
      if (identity?.user_id === flow.linkUid) return reply.redirect('/user/connections?notice=linked');
      if (identity || !(await linkIdentity(flow.linkUid, key, remote))) return failPage(reply, base, '该第三方身份或此登录方式已经绑定账户', 409);
      return reply.redirect('/user/connections?notice=linked');
    }
    if (identity) {
      const user = await findUserByUid(identity.user_id);
      if (!user || user.permission === PERMISSION_BANNED) return failPage(reply, base, '账户不可用', 403);
      await clearSessionCookie(reply, request);
      await request.setSession(user.uid);
      return reply.redirect(safeAuthRedirect(flow.redirect));
    }
    const legacy=remote.email&&await findUserByEmail(remote.email);
    if(legacy){
      if(legacy.permission<0)return failPage(reply,base,'账户不可用',403);
      // A missing local password does not prove ownership. Only a provider's
      // verified email assertion can skip the original mailbox challenge.
      if(remote.emailVerified&&!String(legacy.password||'')){
        try{
          const linkedUid=await transaction(async conn=>{
            const [rows]=await conn.query<any[]>('SELECT uid,email,permission,password,verified FROM users WHERE uid=? FOR UPDATE',[legacy.uid]);
            const user=rows[0];
            if(!user||user.permission<0||user.email.trim().toLowerCase()!==remote.email)throw new Error('原账户邮箱已变化，请重新授权');
            if(String(user.password||''))throw new Error('账户登录方式已变化，请重新授权');
            const existing=await findIdentity(key,remote.id);
            if(existing&&existing.user_id!==user.uid)throw new Error('该第三方身份已绑定其他账户');
            if(!existing&&!await linkIdentity(user.uid,key,remote))throw new Error('此账户已有该提供方的其他绑定，请使用原登录方式');
            if(!user.verified)await conn.query('UPDATE users SET verified=1 WHERE uid=?',[user.uid]);
            return user.uid as number;
          });
          await clearSessionCookie(reply,request);
          await request.setSession(linkedUid);
          return reply.redirect(safeAuthRedirect(flow.redirect));
        }catch(error:any){return failPage(reply,base,error.message||'账户衔接失败，请重新授权',409);}
      }
      // Old PHP retained only the email. Require independent proof before establishing a stable subject binding.
      const token=await createOAuthFlow(request.session!.sid,'legacy-link',{provider:key,redirect:flow.redirect,remote,email:legacy.email.trim().toLowerCase(),legacyUid:legacy.uid},3600);
      return reply.redirect('/auth/oauth/migrate?flow='+encodeURIComponent(token));
    }
    if (!(await registrationEnabled())) return failPage(reply, base, '该身份尚未绑定账户，本站已关闭注册', 403);
    const token = await createOAuthFlow(request.session!.sid, 'pending', { provider: key, redirect: flow.redirect, remote, share: flow.share }, 3600);
    return reply.redirect('/auth/oauth/complete?flow=' + encodeURIComponent(token));
  });
  app.get('/auth/oauth/migrate',async(request,reply)=>{
    const token=String((request.query as any).flow??''),flow=request.session&&await readOAuthFlow(token,request.session.sid,'legacy-link');
    if(!flow?.legacyUid||!flow.remote)return failPage(reply,await view(request),'账户衔接会话无效或已过期，请重新授权');
    return reply.view('auth/oauth-migrate',{...await view(request),flow:token,email:flow.email,providerName:(await findProvider(flow.provider))?.displayName??flow.provider,error:null,sent:false,mailAvailable:mailConfigured()});
  });
  app.post('/auth/oauth/migrate',guarded,async(request,reply)=>{
    const body=textBody(request),token=String(body.flow??''),base=await view(request);
    if(!request.session||!request.checkCsrf(body.csrf))return failPage(reply,base,'会话已过期，请重新授权',403);
    const flow=await readOAuthFlow(token,request.session.sid,'legacy-link');
    if(!flow?.legacyUid||!flow.email||!flow.remote)return failPage(reply,base,'账户衔接会话无效或已过期');
    const render=(error:string|null,sent=false)=>reply.view('auth/oauth-migrate',{...base,flow:token,email:flow.email,providerName:flow.provider,error,sent,mailAvailable:mailConfigured()});
    const user=await findUserByUid(flow.legacyUid);
    if(!user||user.permission<0||user.email.trim().toLowerCase()!==flow.email)return failPage(reply,base,'原账户状态已变化，请重新授权',409);
    if(body.method==='password'){
      if(!user.password||!checkUserPassword(user,String(body.password??'')))return render('原账户密码不正确；没有设置过密码的账户请验证原邮箱');
      try{
        const linked=await completeLegacyOAuth(token,request.session.sid,String(body.password??''));
        if(!linked)return render('账户衔接会话已失效，请重新授权');
        await clearSessionCookie(reply,request);await request.setSession(linked.uid);return reply.redirect(safeAuthRedirect(linked.redirect));
      }catch(error:any){return render(error.message);}
    }
    if(body.method!=='email')return render('请选择验证原邮箱或原账户密码');
    if(!mailConfigured())return render('站点暂未配置邮件服务，请联系管理员或使用原账户密码验证');
    if(await queryOne('SELECT token_hash FROM mcn_email_challenges WHERE user_id=? AND purpose=? AND created_at>?',[user.uid,'legacy-oauth',nowString(-180)]))return render('验证邮件已发送，请稍后再试',true);
    const sent=await sendChallenge('legacy-oauth',user.uid,user.email,{flow:token,browser:tokenHash(request.session.sid)});
    return render(sent?null:'验证邮件未能发送，请稍后重试',sent);
  });
  app.get('/auth/oauth/complete', async (request, reply) => {
    const token = String((request.query as any).flow || '');
    const flow = request.session && await readOAuthFlow(token, request.session.sid, 'pending');
    if (!flow?.remote) return failPage(reply, await view(request), '注册会话无效或已过期');
    return reply.view('auth/oauth-complete', { ...(await view(request)), error: null, sent: false, flow: token,
      email: flow.email || flow.remote.email, nickname: flow.nickname || flow.remote.username, playerName: flow.playerName || '',
      registerWithPlayerName: await getOptionBool('register_with_player_name', true) });
  });
  app.post('/auth/oauth/complete', guarded, async (request, reply) => {
    const body = textBody(request), token = String(body.flow || ''), base = await view(request);
    if (!request.checkCsrf(body.csrf) || !request.session) return failPage(reply, base, '会话已过期', 403);
    const flow = await readOAuthFlow(token, request.session.sid, 'pending');
    if (!flow?.remote) return failPage(reply, base, '注册会话无效或已过期');
    const withPlayer = await getOptionBool('register_with_player_name', true);
    const playerName = withPlayer ? String(body.player_name || '').trim() : undefined;
    const email = String(body.email || '').trim().toLowerCase(), nickname = String(withPlayer ? playerName : body.nickname || '').trim();
    const password = String(body.password || '');
    const render = (error: string | null, sent = false) => reply.view('auth/oauth-complete', { ...base, error, sent, flow: token, email, nickname, playerName: playerName || '', registerWithPlayerName: withPlayer });
    if (!(await registrationEnabled())) return render('本站已关闭注册');
    if (!emailValid(email)) return render('请输入有效邮箱地址');
    if (!nickname || nickname.length > 50) return render('用户名为 1–50 个字符');
    if (password.length < 8 || Buffer.byteLength(password) > 72) return render('密码至少 8 个字符，且不超过 72 字节');
    if (password !== String(body.password_confirm || '')) return render('两次输入的密码不一致');
    if (withPlayer && !validatePlayerName(playerName!)) return render('角色名不符合本站命名规则');
    if (await findUserByEmail(email)) return render('该邮箱已经注册，请先登录原账户后绑定');
    const count = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE ip = ?', [request.ip]);
    if ((count?.c ?? 0) >= Number(await getOption('regs_per_ip', '3'))) return render('当前 IP 的注册数量已达上限');
    flow.email = email; flow.nickname = nickname; flow.playerName = playerName; flow.ip = request.ip;
    flow.passwordHash = await hashPassword(password);
    await exec('UPDATE mcn_oauth_flows SET payload = ? WHERE token_hash = ?', [JSON.stringify(flow), tokenHash(token)]);
    if (flow.remote.emailVerified && flow.remote.email === email) {
      try {
        const created = await completeOAuthRegistration(token, request.session.sid);
        if (!created) return render('注册会话已经失效');
        await clearSessionCookie(reply, request);
        await request.setSession(created.uid);
        return reply.redirect(safeAuthRedirect(created.redirect));
      } catch (error: any) { return render(error.message); }
    }
    if (!mailConfigured()) return render('此登录服务未提供邮箱验证声明，站点需要配置邮件服务才能完成邮箱验证');
    // Bind the email challenge to both the pending flow and initiating browser.
    const recent = await queryOne('SELECT token_hash FROM mcn_email_challenges WHERE purpose = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, ?)) = ? AND created_at > ?', ['oauth', '$.flow', token, nowString(-180)]);
    if (recent) return render('验证邮件已发送，请稍后重试', true);
    if (!(await sendChallenge('oauth', null, email, { flow: token, browser: tokenHash(request.session.sid), email }))) return render('验证邮件发送失败，请稍后重试');
    return render(null, true);
  });
  app.get('/auth/verify-email', async (request, reply) => {
    const token = String((request.query as any).token || ''), base = await view(request);
    if (!token || token.length > 100) return failPage(reply, base, '验证链接无效或已过期');
    const row = await queryOne<any>('SELECT * FROM mcn_email_challenges WHERE token_hash = ? AND purpose IN (?, ?, ?, ?) AND expires_at > ?', [tokenHash(token), 'verify', 'oauth', 'email-change', 'legacy-oauth', nowString()]);
    if (!row) return failPage(reply, base, '验证链接无效或已过期');
    let payload: any;
    try { payload = JSON.parse(row.payload); } catch { return failPage(reply, base, '验证链接无效'); }
    if(row.purpose==='legacy-oauth'){
      if(!request.session||payload.browser!==tokenHash(request.session.sid))return failPage(reply,base,'请在发起第三方授权的同一浏览器中确认原账户',403);
      try{
        const linked=await transaction(async conn=>{
          const [rows]=await conn.query<any[]>('SELECT token_hash FROM mcn_email_challenges WHERE token_hash=? AND expires_at>? FOR UPDATE',[tokenHash(token),nowString()]);
          if(!rows.length)return null;
          const result=await completeLegacyOAuth(payload.flow,request.session!.sid);
          if(!result||result.uid!==row.user_id)throw new Error('账户衔接会话已失效，请重新授权');
          await conn.query('UPDATE users SET verified=1 WHERE uid=? AND verified=0',[row.user_id]);
          await conn.query('DELETE FROM mcn_email_challenges WHERE token_hash=?',[tokenHash(token)]);return result;
        });
        if(!linked)return failPage(reply,base,'验证链接已使用或过期');
        await clearSessionCookie(reply,request);await request.setSession(linked.uid);return reply.redirect(safeAuthRedirect(linked.redirect));
      }catch(error:any){return failPage(reply,base,error.message);}
    }
    if (row.purpose === 'oauth') {
      if (!request.session || payload.browser !== tokenHash(request.session.sid)) return failPage(reply, base, '请在发起第三方注册的同一浏览器中打开验证链接');
      const flow = await readOAuthFlow(payload.flow, request.session.sid, 'pending');
      if (!flow || flow.email !== payload.email) return failPage(reply, base, '注册信息已经变更，请重新发送验证邮件');
      try {
        const created = await transaction(async conn => {
          const [rows] = await conn.query<any[]>('SELECT token_hash FROM mcn_email_challenges WHERE token_hash = ? AND expires_at > ? FOR UPDATE', [tokenHash(token), nowString()]);
          if (!rows.length) return null;
          const result = await completeOAuthRegistration(payload.flow, request.session!.sid);
          await conn.query('DELETE FROM mcn_email_challenges WHERE token_hash = ?', [tokenHash(token)]);
          return result;
        });
        if (!created) return failPage(reply, base, '注册会话已失效');
        await clearSessionCookie(reply, request);
        await request.setSession(created.uid);
        return reply.redirect(safeAuthRedirect(created.redirect));
      } catch (error: any) { return failPage(reply, base, error.message); }
    }
    if (row.purpose === 'email-change' && request.currentUser?.uid !== row.user_id) return failPage(reply, base, '请先登录发起邮箱修改的账户', 403);
    const success = await transaction(async conn => {
      const [rows] = await conn.query<any[]>('SELECT token_hash FROM mcn_email_challenges WHERE token_hash = ? AND expires_at > ? FOR UPDATE', [tokenHash(token), nowString()]);
      if (!rows.length) return false;
      if (row.purpose === 'email-change') {
        const [dups] = await conn.query<any[]>('SELECT uid FROM users WHERE email = ? AND uid <> ? FOR UPDATE', [payload.email, row.user_id]);
        if (dups.length) return false;
        await conn.query('UPDATE users SET email = ?, verified = 1 WHERE uid = ?', [payload.email, row.user_id]);
        await conn.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE user_id = ?', [row.user_id]);
        await conn.query('DELETE FROM mcn_web_sessions WHERE user_id = ?', [row.user_id]);
      } else await conn.query('UPDATE users SET verified = 1 WHERE uid = ?', [row.user_id]);
      await conn.query('DELETE FROM mcn_email_challenges WHERE token_hash = ?', [tokenHash(token)]);
      return true;
    });
    if (!success) return failPage(reply, base, '验证链接已经失效或邮箱已被使用');
    if (row.purpose === 'email-change') {
      await clearSessionCookie(reply, request);
      await request.setSession(row.user_id);
    }
    return reply.redirect('/user/profile');
  });
  app.post('/auth/verify-email/send', guarded, async (request, reply) => {
    if (!request.currentUser || !request.checkCsrf(textBody(request).csrf)) return failPage(reply, await view(request), '请刷新页面后重新登录', 403);
    if (request.currentUser.verified) return reply.redirect('/user/profile');
    const recent = await queryOne('SELECT token_hash FROM mcn_email_challenges WHERE user_id = ? AND purpose = ? AND created_at > ?', [request.currentUser.uid, 'verify', nowString(-180)]);
    if (recent) return failPage(reply, await view(request), '验证邮件已发送，请稍后再试', 429);
    const sent = await sendChallenge('verify', request.currentUser.uid, request.currentUser.email, {});
    return reply.view('auth/notice', { ...(await view(request)), message: sent ? '验证邮件已发送，请检查邮箱' : '邮件服务不可用，请联系管理员' });
  });
  app.get('/auth/oauth/set-password', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    return reply.view('auth/set-password', { ...(await view(request)), hasPassword: !!request.currentUser.password, error: null });
  });
  app.post('/auth/oauth/set-password', guarded, async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login');
    const body = textBody(request), user = request.currentUser;
    const fail = async (error: string) => reply.code(400).view('auth/set-password', { ...(await view(request)), hasPassword: !!user.password, error });
    if (!request.checkCsrf(body.csrf)) return fail('会话已过期');
    if (user.password && !checkUserPassword(user, String(body.current_password || ''))) return fail('当前密码不正确');
    if (String(body.password || '').length < 8 || Buffer.byteLength(String(body.password || '')) > 72) return fail('密码为 8–72 字节');
    await changeUserPassword(user.uid, body.password);
    await request.setSession(user.uid);
    return reply.redirect('/user');
  });
  app.post('/user/connections/:provider/unlink', async (request, reply) => {
    const user = request.currentUser;
    if (!user) return reply.redirect('/auth/login');
    const wantsJson = request.headers.accept?.includes('application/json');
    const fail = async (message: string, code=400) => wantsJson ? reply.code(code).send({code:1,message}) : failPage(reply,await view(request),message,code);
    if (!request.checkCsrf(textBody(request).csrf)) return fail('会话已过期', 403);
    const provider = String((request.params as any).provider);
    const result = await transaction(async conn => {
      const [rows] = await conn.query<any[]>('SELECT password FROM users WHERE uid = ? FOR UPDATE', [user.uid]);
      if (!rows.length || !(await loginMethods(user.uid,rows[0].password)).canUnlink(provider)) return false;
      await conn.query('DELETE FROM mcn_oauth_identities WHERE user_id = ? AND provider = ?', [user.uid, provider]);
      await conn.query('DELETE FROM mcn_web_sessions WHERE user_id = ?', [user.uid]);
      return true;
    });
    if (!result) return fail(await localLoginEnabled() ? '解绑前请先设置密码或绑定另一种可用的登录方式' : '本站已关闭邮箱密码登录，必须保留至少一种可用的第三方登录方式');
    await request.setSession(user.uid);
    if (wantsJson) return {code:0,message:'已解除第三方绑定'};
    return reply.redirect('/user/connections?notice=unlinked');
  });
}
/** Email updates are applied only after proof of ownership of the new mailbox. */
export async function requestEmailChange(uid: number, email: string): Promise<boolean> {
  return emailValid(email) && sendChallenge('email-change', uid, email, { email });
}
