import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from './token.js';
import { findUserByUid } from './user.js';
import { getOptionBool } from './option.js';

function requiredScopes(path: string, write: boolean): string[] {
  const mode = write ? 'ReadWrite' : 'Read';
  if (/^\/api\/user\/notifications/.test(path)) return ['Notification.Read'];
  if (/^\/api\/user$/.test(path)) return ['User.Read'];
  if (/^\/api\/players?(\/|$)/.test(path)) return [`Player.${mode}`];
  if (/^\/api\/closet(\/|$)/.test(path)) return [`Closet.${mode}`];
  const admin = /^\/api\/admin\/(users?|players?|closet|reports?|notifications)(\/|$)/.exec(path)?.[1];
  if (admin) return [`${({ user: 'UsersManagement', users: 'UsersManagement', player: 'PlayersManagement', players: 'PlayersManagement', closet: 'ClosetManagement', report: 'ReportsManagement', reports: 'ReportsManagement', notifications: 'Notification' } as Record<string,string>)[admin]}.${mode}`];
  return [];
}

export async function authorizeApi(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  reply.header('Cache-Control','private, no-store');
  const path = request.url.split('?')[0];
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const bearer = /^Bearer (\S+)$/i.exec(String(request.headers.authorization || ''))?.[1];
  if (bearer) {
    const token = await verifyAccessToken(bearer);
    const user = token && await findUserByUid(token.userId);
    if (!token || !user || user.permission < 0) { reply.code(401).send({ code: 1, message: '无效的访问令牌' }); return false; }
    const scopes = requiredScopes(path, write);
    const has = (scope: string) => token.scopes.includes(scope) || (scope.endsWith('.Read') && token.scopes.includes(scope.replace(/Read$/, 'ReadWrite'))) || (scope === 'Closet.ReadWrite' && token.scopes.includes('Closet.ReadWrtie'));
    if (!scopes.length || !scopes.every(has)) { reply.code(403).send({ code: 1, message: '访问令牌权限不足' }); return false; }
    request.currentUser = user;
    (request as any).apiToken = token;
    request.checkCsrf = () => true; // Credential is explicitly supplied, never browser ambient authority.
  } else {
    if (!request.currentUser || request.currentUser.permission < 0) { reply.code(401).send({ code: 1, message: '请先登录' }); return false; }
    const original = request.checkCsrf;
    request.checkCsrf = token => original(token ?? String((request.body as any)?._token || request.headers['x-csrf-token'] || ''));
  }
  if (write && await getOptionBool('require_verification', false) && !request.currentUser!.verified) {
    reply.code(403).send({ code: 1, message: '请先验证邮箱' }); return false;
  }
  return true;
}
