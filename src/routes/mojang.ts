import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mojangConfiguration, microsoftVerificationUrl, resolveMinecraftIdentity, bindMinecraftIdentity, verificationOf, synchronizeVerifiedUuid, MojangVerificationError } from '../services/mojang.js';
import { createOAuthFlow, readOAuthFlow } from '../services/oauth-client.js';
import { getOptionInt } from '../services/option.js';
import { query } from '../db.js';
import { pageContext } from './page-context.js';

export async function registerMojangRoutes(app: FastifyInstance): Promise<void> {
  const render = async (request: FastifyRequest, reply: FastifyReply, error: string | null = null, status = 200) => {
    const user = request.currentUser;
    if (!user) return reply.redirect('/auth/login?redirect=/user/verification');
    const verification = await verificationOf(user.uid);
    const settings = await mojangConfiguration();
    const mappings = verification ? await query<{ name: string }>('SELECT u.name FROM `uuid` u JOIN players p ON p.name=u.name WHERE u.uuid=? AND p.uid=?', [verification.uuid,user.uid]) : [];
    return reply.code(status).view('user/verification', {
      ...(await pageContext(request, 'Minecraft 正版验证')),
      verification, mappings, configured: settings.configured, configurationProblem: settings.problem,
      reward: Math.max(0, await getOptionInt('mojang_verification_score_award', 0)), error,
      completed: (request.query as any)?.completed === '1' && !!verification?.verified,
    });
  };
  const failure = async (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (error instanceof MojangVerificationError) return render(request, reply, error.message, error.statusCode);
    request.log.error({ message: 'Minecraft verification failed unexpectedly' });
    return render(request, reply, '认证服务暂时不可用，请稍后重新验证。', 502);
  };
  app.get('/user/verification', async (request, reply) => render(request, reply));
  const start = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.currentUser || !request.session?.uid) return reply.redirect('/auth/login?redirect=/user/verification');
    if (request.method === 'POST' && !request.checkCsrf((request.body as any)?.csrf)) return render(request, reply, '会话已过期，请刷新页面后重试。', 403);
    const existing = await verificationOf(request.currentUser.uid);
    if (existing?.verified) return render(request, reply, '此账户已完成正版验证。', 409);
    const settings = await mojangConfiguration();
    if (!settings.configured) return render(request, reply, settings.problem, 503);
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = await createOAuthFlow(request.session.sid, 'mojang-verification', { provider: 'mojang-verification', redirect: '/user/verification', redirectUri: settings.redirectUri, verifier, linkUid: request.currentUser.uid });
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return reply.redirect(microsoftVerificationUrl(settings, state, verifier));
  };
  app.get('/mojang/verify', start);
  app.post('/mojang/verify', start);
  app.get('/mojang/callback', async (request, reply) => {
    if (!request.currentUser || !request.session?.uid) return reply.redirect('/auth/login?redirect=/user/verification');
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const params = request.query as Record<string, string>;
    if (Object.values(params).some((value) => typeof value !== 'string')) return render(request, reply, '认证回调参数无效，请重新发起验证。', 400);
    const flow = await readOAuthFlow(params.state ?? '', request.session.sid, 'mojang-verification', true);
    if (!flow || flow.linkUid !== request.currentUser.uid || !flow.verifier) return render(request, reply, '此次验证与当前登录会话不匹配或已经过期，请重新发起验证。', 400);
    if (params.error) return render(request, reply, params.error === 'access_denied' ? '你已取消此次 Microsoft 授权。' : 'Microsoft 未批准此次授权，请重新发起验证。', 400);
    if (!params.code || params.code.length > 4096) return render(request, reply, '认证回调缺少有效凭证，请重新发起验证。', 400);
    try {
      const settings = await mojangConfiguration();
      if (settings.redirectUri !== flow.redirectUri) throw new MojangVerificationError('configuration_changed', '验证配置已变更，请重新发起验证。');
      const identity = await resolveMinecraftIdentity(settings, params.code, flow.verifier);
      await bindMinecraftIdentity(request.currentUser.uid, identity);
      return reply.redirect('/user/verification?completed=1');
    } catch (error) { return failure(request, reply, error); }
  });
  app.post('/mojang/update-uuid', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login?redirect=/user/verification');
    if (!request.checkCsrf((request.body as any)?.csrf)) return render(request, reply, '会话已过期，请刷新页面后重试。', 403);
    try {
      await synchronizeVerifiedUuid(request.currentUser.uid);
      if (request.headers.accept?.includes('application/json')) return { code: 0, message: '正版 UUID 已同步，请在启动器重新登录。' };
      return reply.redirect('/user/verification');
    } catch (error) { return failure(request, reply, error); }
  });
}
