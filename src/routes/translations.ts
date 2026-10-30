import type { FastifyInstance } from 'fastify';
import { translationLines, createTranslationLine, updateTranslationLine, deleteTranslationLine } from '../services/translations.js';
import { pageContext } from './page-context.js';

export async function registerTranslationRoutes(app: FastifyInstance): Promise<void> {
  const guard = (request: any, reply: any, write = false) => {
    if (!request.currentUser || request.currentUser.permission < 1) { reply.code(403).send({ code: 1, message: '需要管理员权限' }); return false; }
    const body = request.body ?? {};
    if (write && !request.checkCsrf(body.csrf ?? body._token ?? request.headers['x-csrf-token'])) { reply.code(403).send({ code: 1, message: 'CSRF 校验失败' }); return false; }
    return true;
  };
  const locale = (request: any) => String(request.body?.locale ?? request.query?.locale ?? request.currentUser?.locale ?? 'zh_CN');
  app.get('/admin/i18n/list', async (request, reply) => {
    if (!guard(request, reply)) return;
    return translationLines(Number((request.query as any)?.page ?? 1));
  });
  app.post('/admin/i18n', async (request, reply) => {
    if (!guard(request, reply, true)) return;
    const body = (request.body ?? {}) as Record<string, string>;
    await createTranslationLine(String(body.group ?? ''), String(body.key ?? ''), locale(request), String(body.text ?? ''));
    return reply.redirect('/admin/i18n');
  });
  app.put('/admin/i18n/:id', async (request, reply) => {
    if (!guard(request, reply, true)) return;
    const changed = await updateTranslationLine(Number((request.params as any).id), locale(request), String((request.body as any)?.text ?? ''));
    return reply.code(changed ? 200 : 404).send({ code: changed ? 0 : 1, message: changed ? '翻译已更新' : '翻译不存在' });
  });
  app.delete('/admin/i18n/:id', async (request, reply) => {
    if (!guard(request, reply, true)) return;
    const changed = await deleteTranslationLine(Number((request.params as any).id));
    return reply.code(changed ? 200 : 404).send({ code: changed ? 0 : 1, message: changed ? '翻译已删除' : '翻译不存在' });
  });
  const renderPage = async (request: any, reply: any) => {
    if(!request.currentUser)return reply.redirect('/auth/login?redirect=/admin/i18n');
    if(request.currentUser.permission<1)return reply.redirect('/user?notice=permission-denied');
    return reply.view('admin/translations', {
      ...(await pageContext(request, '语言覆盖')),
      ...(await translationLines(Number((request.query as any)?.page ?? 1))),
      locale: locale(request),
    });
  };
  app.get('/admin/i18n', renderPage);
  app.get('/admin/translations', renderPage);
  app.post('/admin/i18n/save', async (request, reply) => {
    if (!guard(request, reply, true)) return;
    const body = request.body as Record<string, string>;
    if (body.action === 'delete') await deleteTranslationLine(Number(body.id));
    else await updateTranslationLine(Number(body.id), locale(request), String(body.text ?? ''));
    return reply.redirect('/admin/i18n?locale=' + encodeURIComponent(locale(request)));
  });
}
