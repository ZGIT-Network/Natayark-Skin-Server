import type { FastifyInstance } from 'fastify';
import { exec, queryOne, withTransaction, nowString } from '../db.js';
import { authorizeApi } from '../services/api-access.js';
import { revokeAllTokensForUser } from '../services/token.js';
import { findUserByUid, addScore, isAdmin } from '../services/user.js';
import { addPlayer, deletePlayer, renamePlayer, findPlayerByPid, setPlayerTexture, clearPlayerTexture } from '../services/player.js';
import {
  closetAdd,
  closetRemove,
  closetRename,
  closetHas,
  findTextureByTid,
  uploadTexture,
  deleteTexture,
  setDescription,
  setTexturePrivacy,
} from '../services/texture.js';
import { getOptionInt } from '../services/option.js';
import { yggLog } from '../services/ygglog.js';
import { renderMarkdown, validateDescription } from '../services/content.js';

function fail(reply: any, code: number, message: string) {
  return reply.code(code).send({ code: 1, message });
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // Session-auth guard for /api/* JSON endpoints only (Yggdrasil endpoints authenticate themselves).
  app.addHook('preHandler', async (request, reply) => {
    if ((request.routeOptions.config as any)?.publicApi) return;
    const url = request.raw.url ?? '';
    if ((!url.startsWith('/api/') || url.startsWith('/api/yggdrasil')) && !(request.routeOptions.config as any)?.legacyWrite) return;
    if (!await authorizeApi(request, reply)) return reply;
  });

  // --- Players ---------------------------------------------------------------
  app.post('/api/player', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const result = await addPlayer(request.currentUser!.uid, String(body.name ?? ''));
    if (!result.ok) {
      const messages: Record<string, string> = {
        invalid_name: '角色名不符合本站命名规则',
        dup_name: '该角色名已被占用',
        limit_reached: '角色数量已达上限',
        score_not_enough: '积分不足',
      };
      return fail(reply, 400, messages[result.reason] ?? '无法添加角色');
    }
    return { code: 0, message: '角色添加成功', pid: result.player.pid, uuid: result.uuid };
  });

  app.delete('/api/player/:pid', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const player = await findPlayerByPid(parseInt((request.params as any).pid, 10));
    if (!player) return fail(reply, 404, '角色不存在');
    if (player.uid !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权操作该角色');
    await deletePlayer(player);
    return { code: 0, message: '角色已删除' };
  });

  app.put('/api/player/:pid/name', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const player = await findPlayerByPid(parseInt((request.params as any).pid, 10));
    if (!player) return fail(reply, 404, '角色不存在');
    if (player.uid !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权操作该角色');
    const result = await renamePlayer(player, String(body.name ?? ''));
    if (!result.ok) {
      return fail(reply, 400, result.reason === 'dup_name' ? '该角色名已被占用' : '角色名不符合本站命名规则');
    }
    return { code: 0, message: '重命名成功' };
  });

  app.put('/api/player/:pid/textures', async (request, reply) => {
    const body = request.body as Record<string, any>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const player = await findPlayerByPid(parseInt((request.params as any).pid, 10));
    if (!player) return fail(reply, 404, '角色不存在');
    if (player.uid !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权操作该角色');

    const skinTid = body.skin !== undefined ? parseInt(body.skin, 10) || 0 : null;
    const capeTid = body.cape !== undefined ? parseInt(body.cape, 10) || 0 : null;

    for (const [type, tid] of [['skin', skinTid], ['cape', capeTid]] as const) {
      if (tid === null || tid === 0) continue;
      const texture = await findTextureByTid(tid);
      if (!texture) return fail(reply, 400, `材质 #${tid} 不存在`);
      if (type === 'skin' && texture.type === 'cape') return fail(reply, 400, '不能将披风设置为皮肤');
      if (type === 'cape' && texture.type !== 'cape') return fail(reply, 400, '不能将皮肤设置为披风');
      const owned = await closetHas(player.uid, tid);
      if (!owned && !isAdmin(request.currentUser)) return fail(reply, 403, '请先将材质加入衣柜');
    }
    if (skinTid !== null) {
      if (skinTid === 0) await clearPlayerTexture(player, 'skin');
      else await setPlayerTexture(player, 'skin', skinTid);
    }
    if (capeTid !== null) {
      if (capeTid === 0) await clearPlayerTexture(player, 'cape');
      else await setPlayerTexture(player, 'cape', capeTid);
    }
    return { code: 0, message: '材质已更新' };
  });

  app.delete('/api/player/:pid/textures/:type', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const player = await findPlayerByPid(parseInt((request.params as any).pid, 10));
    if (!player) return fail(reply, 404, '角色不存在');
    if (player.uid !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权操作该角色');
    const type = (request.params as any).type;
    if (!['skin', 'cape'].includes(type)) return fail(reply, 400, '无效的材质类型');
    await clearPlayerTexture(player, type);
    return { code: 0, message: '材质已清除' };
  });

  // --- Closet ------------------------------------------------------------------
  app.post('/api/closet', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const tid = parseInt(body.tid ?? '0', 10);
    const result = await closetAdd(request.currentUser!.uid, tid, String(body.name ?? ''));
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: '材质不存在或无权访问',
        dup: '该材质已在衣柜中',
        lack_score: '积分不足',
      };
      return fail(reply, 400, messages[result.reason ?? ''] ?? '无法添加到衣柜');
    }
    return { code: 0, message: '已添加到衣柜' };
  });

  app.put('/api/closet/:tid', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const tid = parseInt((request.params as any).tid, 10);
    if (!(await closetHas(request.currentUser!.uid, tid))) return fail(reply, 404, '衣柜中不存在该材质');
    await closetRename(request.currentUser!.uid, tid, String(body.name ?? '').slice(0, 50));
    return { code: 0, message: '重命名成功' };
  });

  app.delete('/api/closet/:tid', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const tid = parseInt((request.params as any).tid, 10);
    await closetRemove(request.currentUser!.uid, tid);
    return { code: 0, message: '已从衣柜移除' };
  });

  // --- Skinlib --------------------------------------------------------------------
  app.post('/api/skinlib', async (request, reply) => {
    const parts = request.parts();
    let file: Buffer | null = null;
    let fileName = 'texture.png';
    let meta: Record<string, string> = {};
    let csrf = '';
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        file = await part.toBuffer();
        fileName = part.filename || fileName;
      } else if (part.type === 'field') {
        meta[part.fieldname] = String(part.value ?? '');
        if (part.fieldname === 'csrf') csrf = String(part.value);
      }
    }
    if (!request.checkCsrf(csrf)) return fail(reply, 403, 'CSRF 校验失败');
    if (!file) return fail(reply, 400, '请选择要上传的文件');

    const type = meta.type === 'cape' ? 'cape' : meta.type === 'alex' || meta.model === 'slim' ? 'alex' : 'steve';
    const name = (meta.name ?? '').trim().slice(0, 50) || fileName.replace(/\.png$/i, '');
    const { textureNameValid } = await import('../services/texture.js');
    if (!(await textureNameValid(name))) return fail(reply, 400, '材质名称不符合规则');
    let description: string;
    try { description = await validateDescription(meta.description); }
    catch (error: any) { return fail(reply, 422, error.message); }

    const result = await uploadTexture(
      { uid: request.currentUser!.uid, score: request.currentUser!.score },
      { name, type, isPublic: meta.public === '1' || meta.public === 'true' },
      { data: file, name },
      { description }
    );
    if (!result.ok) {
      const messages: Record<string, string> = {
        lack_score: '积分不足,无法上传',
        'file-too-large': '文件过大',
        'invalid-image': '不是有效的 PNG 图片',
        'invalid-cape-size': '披风尺寸无效,宽高比必须为 2:1',
        'invalid-skin-size': '皮肤尺寸无效,宽高比必须为 1:1 或 2:1',
        'invalid-slim-size': 'Alex(纤细)模型皮肤必须是 1:1 正方形',
        'invalid-hd-skin': '高清皮肤宽度必须是 64 的倍数、高度是 32 的倍数',
      };
      return fail(reply, 400, messages[result.reason] ?? '上传失败');
    }
    return {
      code: result.duplicate ? 2 : 0,
      message: result.duplicate ? '该材质已存在' : '上传成功',
      tid: result.texture.tid,
      cost: result.cost,
      redirect: `/skinlib/show/${result.texture.tid}`,
    };
  });

  app.delete('/api/skinlib/:tid', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const texture = await findTextureByTid(parseInt((request.params as any).tid, 10));
    if (!texture) return fail(reply, 404, '材质不存在');
    if (texture.uploader !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权删除该材质');
    await deleteTexture(texture);
    return { code: 0, message: '材质已删除' };
  });

  app.put('/api/skinlib/:tid/privacy', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const texture = await findTextureByTid(parseInt((request.params as any).tid, 10));
    if (!texture) return fail(reply, 404, '材质不存在');
    if (texture.uploader !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权修改该材质');
    const isPublic = body.public === '1' || body.public === 'true';
    const result = await setTexturePrivacy(texture, isPublic);
    if (!result.ok) return fail(reply, 400, result.reason === 'lack_score' ? '积分不足' : result.reason === 'duplicate' ? '公开材质已存在' : '材质不存在');
    return { code: 0, message: isPublic ? '已设为公开' : '已设为私有' };
  });

  app.put('/api/skinlib/:tid/description', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const texture = await findTextureByTid(parseInt((request.params as any).tid, 10));
    if (!texture) return fail(reply, 404, '材质不存在');
    if (texture.uploader !== request.currentUser!.uid && !isAdmin(request.currentUser)) return fail(reply, 403, '无权修改该材质');
    let description: string;
    try { description = await validateDescription(body.description); }
    catch (error: any) { return fail(reply, 422, error.message); }
    await setDescription(texture.tid, description);
    return { code: 0, message: '描述已更新', html: renderMarkdown(description) };
  });

  app.post('/api/skinlib/:tid/report', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const texture = await findTextureByTid(parseInt((request.params as any).tid, 10));
    if (!texture) return fail(reply, 404, '材质不存在');
    const reason = String(body.reason ?? '').trim().slice(0, 1000);
    if (!reason) return fail(reply, 400, '请填写举报理由');
    const reporterScore = await getOptionInt('reporter_score_modification', 0);
    const result = await withTransaction(async () => {
      const user = await queryOne<any>('SELECT uid, score FROM users WHERE uid = ? FOR UPDATE', [request.currentUser!.uid]);
      if (await queryOne('SELECT id FROM reports WHERE reporter = ? AND tid = ? LIMIT 1', [user.uid, texture.tid])) return 'duplicate';
      if (user.score + reporterScore < 0) return 'score';
      await exec('INSERT INTO reports (tid,uploader,reporter,reason,status,report_at) VALUES (?,?,?,?,0,?)', [texture.tid, texture.uploader, user.uid, reason, nowString()]);
      await addScore(user.uid, reporterScore);
      return 'ok';
    });
    if (result !== 'ok') return fail(reply, 400, result === 'duplicate' ? '你已举报过该材质' : '积分不足');
    return { code: 0, message: '举报已提交,感谢你的贡献' };
  });

  app.post('/api/admin/report/:id/review', async (request, reply) => {
    if (!isAdmin(request.currentUser)) return fail(reply, 403, '需要管理员权限');
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const id = parseInt((request.params as any).id, 10);
    const action = body.action ?? (body.approve === '1' ? 'delete' : 'reject');
    if (!['delete','ban','reject'].includes(action)) return fail(reply, 400, '无效操作');
    return withTransaction(async () => {
      const report = await queryOne<any>('SELECT * FROM reports WHERE id = ? FOR UPDATE', [id]);
      if (!report) return fail(reply, 404, '举报不存在');
      if (report.status !== 0) return fail(reply, 409, '该举报已处理');
      let reward = action !== 'reject';
      if (action === 'delete') {
        const texture = await findTextureByTid(report.tid);
        if (texture) await deleteTexture(texture); else reward = false;
      } else if (action === 'ban') {
        const uploader = await findUserByUid(report.uploader);
        if (!uploader || uploader.permission >= request.currentUser!.permission) return fail(reply, 403, '无权封禁该用户');
        await exec('UPDATE users SET permission = -1 WHERE uid = ?', [uploader.uid]);
        await revokeAllTokensForUser(uploader.uid);
      }
      const modification = await getOptionInt('reporter_score_modification', 0);
      if (action === 'reject' && modification > 0) await addScore(report.reporter, -modification);
      if (action !== 'reject' && modification < 0) await addScore(report.reporter, -modification);
      if (reward) await addScore(report.reporter, await getOptionInt('reporter_reward_score', 0));
      await exec('UPDATE reports SET status = ? WHERE id = ?', [action === 'reject' ? 2 : 1, id]);
      return { code: 0, message: '举报已处理', status: action === 'reject' ? 2 : 1 };
    });
  });

  // --- Admin user/player management -------------------------------------------
  app.put('/api/admin/user/:uid', async (request, reply) => {
    if (!isAdmin(request.currentUser)) return fail(reply, 403, '需要管理员权限');
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const uid = parseInt((request.params as any).uid, 10);
    const user = await findUserByUid(uid);
    if (!user) return fail(reply, 404, '用户不存在');
    const field = String(body.field ?? '');
    const value = String(body.value ?? '');
    if (user.permission >= request.currentUser!.permission && user.uid !== request.currentUser!.uid) return fail(reply, 403, '不能修改同级或更高权限用户');
    switch (field) {
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || await queryOne('SELECT uid FROM users WHERE email = ? AND uid <> ?', [value.trim(),uid])) return fail(reply,400,'邮箱无效或已被使用');
        await exec('UPDATE users SET email = ? WHERE uid = ?', [value.trim().toLowerCase(), uid]);
        break;
      case 'nickname':
        await exec('UPDATE users SET nickname = ? WHERE uid = ?', [value.slice(0, 50), uid]);
        break;
      case 'score':
        await exec('UPDATE users SET score = ? WHERE uid = ?', [parseInt(value, 10) || 0, uid]);
        break;
      case 'permission': {
        const perm = parseInt(value, 10);
        if (![-1, 0, 1].includes(perm)) return fail(reply, 400, '无效的权限值');
        if (uid === request.currentUser!.uid || user.permission >= request.currentUser!.permission || (perm === 1 && request.currentUser!.permission < 2)) return fail(reply, 403, '无权修改此权限');
        await exec('UPDATE users SET permission = ? WHERE uid = ?', [perm, uid]);
        if (perm === -1) await revokeAllTokensForUser(uid);
        break;
      }
      case 'verified':
        await exec('UPDATE users SET verified = ? WHERE uid = ?', [value === '1' ? 1 : 0, uid]);
        break;
      case 'password':
        if (value.length < 8) return fail(reply, 400, '密码长度至少为 8 位');
        await exec('UPDATE users SET password = ? WHERE uid = ?', [await (await import('../services/cipher.js')).hashPassword(value), uid]);
        await revokeAllTokensForUser(uid);
        break;
      default:
        return fail(reply, 400, '无效的字段');
    }
    return { code: 0, message: '已更新' };
  });

  app.delete('/api/admin/user/:uid', async (request, reply) => {
    if (request.currentUser!.permission < 2) return fail(reply, 403, '只有超级管理员能删除用户');
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const uid = parseInt((request.params as any).uid, 10);
    if (uid === request.currentUser!.uid) return fail(reply, 400, '不能删除自己');
    await exec('DELETE FROM players WHERE uid = ?', [uid]);
    await exec('DELETE FROM user_closet WHERE user_uid = ?', [uid]);
    await exec('DELETE FROM users WHERE uid = ?', [uid]);
    return { code: 0, message: '用户已删除' };
  });

  app.put('/api/admin/player/:pid', async (request, reply) => {
    if (!isAdmin(request.currentUser)) return fail(reply, 403, '需要管理员权限');
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const player = await findPlayerByPid(parseInt((request.params as any).pid, 10));
    if (!player) return fail(reply, 404, '角色不存在');
    const field = String(body.field ?? '');
    if (field === 'name') {
      const result = await renamePlayer(player, String(body.value ?? ''));
      if (!result.ok) return fail(reply, 400, result.reason === 'dup_name' ? '该角色名已被占用' : '角色名不符合规则');
    } else if (field === 'owner') {
      const newUid = parseInt(body.value, 10);
      const owner = await findUserByUid(newUid);
      if (!owner) return fail(reply, 400, '目标用户不存在');
      await exec('UPDATE players SET uid = ? WHERE pid = ?', [newUid, player.pid]);
    } else if (field === 'skin' || field === 'cape') {
      const tid = parseInt(body.value, 10) || 0;
      if (tid === 0) await clearPlayerTexture(player, field);
      else await setPlayerTexture(player, field, tid);
    } else {
      return fail(reply, 400, '无效的字段');
    }
    return { code: 0, message: '已更新' };
  });

  app.delete('/api/admin/player/:pid', async (request, reply) => {
    if (!isAdmin(request.currentUser)) return fail(reply, 403, '需要管理员权限');
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return fail(reply, 403, 'CSRF 校验失败');
    const player = await findPlayerByPid(parseInt((request.params as any).pid, 10));
    if (!player) return fail(reply, 404, '角色不存在');
    await deletePlayer(player, { bypassLimit: true });
    return { code: 0, message: '角色已删除' };
  });
}
