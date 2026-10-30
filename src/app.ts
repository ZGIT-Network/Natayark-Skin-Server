import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import view from '@fastify/view';
import ejs from 'ejs';
import { config, isDev } from './config.js';
import { registerWebRoutes } from './routes/web.js';
import { registerApiRoutes } from './routes/api.js';
import { registerYggdrasilRoutes, YggdrasilError } from './routes/yggdrasil.js';
import { registerOidcRoutes } from './routes/oidc.js';
import { registerTextureRoutes } from './routes/textures.js';
import { registerApplicationRoutes } from './routes/applications.js';
import { registerSharingRoutes } from './routes/sharing.js';
import { registerTranslationRoutes } from './routes/translations.js';
import { registerMojangRoutes } from './routes/mojang.js';
import { icon } from './icons.js';
import { loadSession, csrfToken, checkCsrf, setSessionCookie, clearSessionCookie } from './services/session.js';
import { loadOptions } from './services/option.js';
import { ensureSigningKey, getSystemClientId } from './services/token.js';
import { loadPlayerNameRules } from './util.js';
import { translate, type Locale } from './i18n.js';
import { ROOT_DIR } from './config.js';
import { captureApiHandlers, registerCompatRoutes } from './routes/compat.js';
import { pageContext } from './routes/page-context.js';
import { maskUuid } from './services/uuid.js';


export async function createApp() {
const app = Fastify({
  disableRequestLogging: true,
  rewriteUrl(request) {
    const [pathname, ...search] = (request.url || '/').split('?');
    const aliases: Record<string,string> = {
      '/oauth/authorize':'/connect/authorize', '/oauth/token':'/connect/token', '/oauth/revoke':'/connect/revoke',
      '/auth':'/connect/authorize', '/token':'/connect/token', '/jwks':'/connect/jwks',
      '/device/auth':'/connect/device_authorize', '/device':'/connect/device', '/token/revocation':'/connect/revoke',
    };
    return (aliases[pathname] || pathname) + (search.length ? '?' + search.join('?') : '');
  },
  logger: isDev
    ? { level: 'info', transport: undefined, redact: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie'] }
    : { level: 'warn', redact: ['req.headers.authorization','req.headers.cookie','res.headers.set-cookie'] },
  trustProxy: config.trustProxy,
  bodyLimit: 16 * 1024 * 1024,
});
const handlers = captureApiHandlers(app);

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 4 } });

// Canonical loopback origin. Cookies and the OAuth redirect_uri bind to
// PUBLIC_ORIGIN, so browsing via a different loopback alias (localhost vs
// 127.0.0.1) loses the session cookie when the provider redirects back.
// Page navigations are redirected to the canonical origin; machine-facing
// API paths are left untouched.
const PUBLIC_URL = config.publicOrigin ? new URL(config.publicOrigin) : null;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
function hostOf(value: string): string {
  const host = (value || '').toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return host.split(':')[0];
}
app.addHook('onRequest', async (request, reply) => {
  if (!PUBLIC_URL || !LOOPBACK.has(PUBLIC_URL.hostname)) return;
  const host = hostOf(String(request.headers.host || ''));
  if (host === PUBLIC_URL.hostname || !LOOPBACK.has(host)) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const secFetch = String(request.headers['sec-fetch-mode'] || '');
  if (!secFetch.includes('navigate') && !String(request.headers.accept || '').includes('text/html')) return;
  return reply.redirect(PUBLIC_URL.origin + (request.raw.url ?? '/'), 308);
});

// CORS for the public API surface (authlib-injector tools / OIDC clients)
const CORS_PREFIXES = ['/api/yggdrasil', '/minecraftservices', '/connect', '/.well-known', '/userinfo', '/yggc/userinfo'];
app.addHook('onRequest', async (request, reply) => {
  const url = request.raw.url ?? '';
  if (!CORS_PREFIXES.some((p) => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'))) return;
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  reply.header('Access-Control-Max-Age', '86400');
  if (request.method === 'OPTIONS') {
    return reply.code(204).send();
  }
});

await app.register(staticFiles, {
  root: path.join(ROOT_DIR, 'public'),
  prefix: '/',
  decorateReply: false,
});
await app.register(staticFiles, {
  root: path.join(ROOT_DIR, 'public', 'vendor'),
  prefix: '/vendor/',
  decorateReply: true,
});

await app.register(view, {
  engine: { ejs },
  root: path.join(ROOT_DIR, 'src', 'views'),
  defaultContext: { icon, maskUuid },
  includeViewExtension: true,
});

// HTML includes session-specific navigation and CSRF values, including on public pages.
app.addHook('onSend', async (_request, reply, payload) => {
  if (String(reply.getHeader('content-type') || '').startsWith('text/html')) {
    reply.header('Cache-Control', 'private, no-store');
    const vary = String(reply.getHeader('vary') || '').split(',').map(v => v.trim()).filter(Boolean);
    if (!vary.some(v => v.toLowerCase() === 'cookie')) vary.push('Cookie');
    reply.header('Vary', vary.join(', '));
  }
  return payload;
});

// --- Per-request session/user loading + helpers -----------------------------
app.addHook('onRequest', async (request, reply) => {
  await loadSession(request, reply);
  (request as any).csrfToken = () => csrfToken((request as any).session);
  (request as any).checkCsrf = (token?: string) => checkCsrf(request, token);
  (request as any).setSession = (uid: number) => setSessionCookie(reply, uid);
  (request as any).clearSession = () => clearSessionCookie(reply, request);
  (request as any).t = (key: string) => {
    const override = (request.query as any)?.lang;
    const locale: Locale = override === 'en' || override === 'zh_CN' ? override
      : ((request as any).currentUser?.locale as Locale) === 'en' ? 'en' : 'zh_CN';
    return translate(locale, key);
  };
  reply.header('X-Powered-By', 'Natayark SkinServer');
});

// Yggdrasil error mapping
app.setErrorHandler((error: any, request, reply) => {
  if (error instanceof YggdrasilError) {
    return reply.code(error.statusCode).send({ error: error.errorCode, errorMessage: error.message });
  }
  if (error.statusCode === 429) {
    return reply.code(429).send({ error: 'ForbiddenOperationException', errorMessage: '请求过于频繁,请稍后再试' });
  }
  if (error.statusCode && error.statusCode >= 400) {
    if ((request as any).raw?.url?.startsWith('/api/yggdrasil') || (request as any).raw?.url?.startsWith('/connect')) {
      return reply.code(error.statusCode).send({ error: 'IllegalArgumentException', errorMessage: error.message });
    }
    if (isDev) {
      app.log.error(error);
      return reply.code(error.statusCode).send({ error: error.name, errorMessage: error.message, stack: error.stack });
    }
    app.log.error(error);
    return reply.code(error.statusCode).send({ message: error.message });
  }
  app.log.error(error);
  return reply.code(500).send({ message: 'Internal Server Error' });
});

// Not found
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/connect')) {
    return reply.code(404).send({ error: 'NotFoundException', errorMessage: 'Not Found' });
  }
  return reply.code(404).view('error', { ...(await pageContext(request, '404')), code: 404, message: '页面不存在。' });
});

// Rate limiting for the auth endpoints (brute-force protection)
await app.register(rateLimit, {
  global: false,
  max: (request) => {
    const url = request.raw.url ?? '';
    if (url.startsWith('/api/yggdrasil/authserver')) return Math.max(10, config.yggRateLimit);
    if (url.startsWith('/auth/login') || url.startsWith('/auth/register')) return 30;
    return 1000;
  },
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
});

// --- Register route groups ----------------------------------------------------
await registerApplicationRoutes(app);
await registerSharingRoutes(app);
await registerTranslationRoutes(app);
await registerMojangRoutes(app);
await registerTextureRoutes(app);
await registerYggdrasilRoutes(app);
await registerOidcRoutes(app);
await registerApiRoutes(app);
await registerCompatRoutes(app, handlers);
await registerWebRoutes(app);


  await loadOptions(true);
  await ensureSigningKey();
  await getSystemClientId();
  await loadPlayerNameRules();
  return app;
}
