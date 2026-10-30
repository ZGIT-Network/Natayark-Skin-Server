import type { FastifyInstance } from 'fastify';
import { registrationLinks, createRegistrationLink, removeRegistrationLink, sharingEnabled } from '../services/sharing.js';
import { pageContext } from './page-context.js';

export async function registerSharingRoutes(app: FastifyInstance): Promise<void> {
  const isPageRequest = (request:any) => request.url.split('?')[0] === '/user/sharing' && !request.headers.accept?.includes('application/json') && !String(request.headers['content-type']).includes('application/json');
  const guard = async (request: any, reply: any) => {
    const pageRequest = isPageRequest(request);
    if(pageRequest && !request.currentUser) { reply.redirect('/auth/login?redirect=/user/sharing'); return false; }
    if(pageRequest && !(await sharingEnabled())) { reply.redirect('/user?notice=sharing-disabled'); return false; }
    if (!request.currentUser) { reply.code(401).send({ code: 1, message: '请先登录' }); return false; }
    if (request.currentUser.permission < 0) { reply.code(403).send({ code: 1, message: '账号已封禁' }); return false; }
    if (!(await sharingEnabled())) { reply.code(404).send({ code: 1, message: '分享注册功能未启用' }); return false; }
    return true;
  };
  const csrf = (request: any, reply: any) => {
    const body = request.body ?? {};
    if (request.checkCsrf(body.csrf ?? body._token ?? request.headers['x-csrf-token'])) return true;
    if(isPageRequest(request)){reply.redirect('/user/sharing?notice=session-expired');return false;}
    reply.code(403).send({ code: 1, message: 'CSRF 校验失败' });
    return false;
  };
  app.get('/user/reg-links', async (request, reply) => {
    if (!(await guard(request, reply))) return;
    return registrationLinks(request.currentUser!.uid);
  });
  app.post('/user/reg-links', async (request, reply) => {
    if (!(await guard(request, reply)) || !csrf(request, reply)) return;
    return { code: 0, message: '注册链接已生成。', data: { record: await createRegistrationLink(request.currentUser!.uid) } };
  });
  app.delete('/user/reg-links/:id', async (request, reply) => {
    if (!(await guard(request, reply)) || !csrf(request, reply)) return;
    const removed = await removeRegistrationLink(request.currentUser!.uid, Number((request.params as any).id));
    return reply.code(removed ? 200 : 404).send({ code: removed ? 0 : 1, message: removed ? '链接已删除' : '链接不存在或不属于你' });
  });
  app.get('/user/sharing', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login?redirect=/user/sharing');
    if (!(await guard(request, reply))) return;
    return reply.view('user/sharing', {
      ...(await pageContext(request, '分享注册链接')),
      ...(await registrationLinks(request.currentUser.uid)),
    });
  });
  app.post('/user/sharing', async (request, reply) => {
    if (!(await guard(request, reply)) || !csrf(request, reply)) return;
    const body = request.body as Record<string, string>;
    if (body.action === 'delete') {
      const removed=await removeRegistrationLink(request.currentUser!.uid, Number(body.id));
      return reply.redirect('/user/sharing?notice='+(removed?'registration-link-deleted':'registration-link-missing'));
    }
    await createRegistrationLink(request.currentUser!.uid);
    return reply.redirect('/user/sharing?notice=registration-link-created');
  });
}
