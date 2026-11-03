import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { boundedEnv } from './work-limit.js';

/** IP budget runs before parsing and also covers routes with account-level limits. */
export async function registerRequestLimits(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
  const authIp = app.createRateLimit({ max: boundedEnv('AUTH_IP_RATE_LIMIT', Math.max(10, config.yggRateLimit), 10000), timeWindow: '1 minute', ipv6Subnet: 56 });
  const globalIp = app.createRateLimit({ max: 1000, timeWindow: '1 minute', ipv6Subnet: 56 });
  app.addHook('onRequest', async (request, reply) => {
    const global = await globalIp(request);
    const sensitive = /^(?:\/auth\/|\/connect\/|\/api\/yggdrasil\/authserver\/|\/user\/profile)/.test(request.url);
    const auth = sensitive ? await authIp(request) : null;
    const denied = !global.isAllowed && global.isExceeded ? global : auth && !auth.isAllowed && auth.isExceeded ? auth : null;
    if (denied) return reply.header('Retry-After', denied.ttlInSeconds).code(429).send({ error: 'rate_limit_exceeded', errorMessage: '请求过于频繁，请稍后再试' });
  });
}
