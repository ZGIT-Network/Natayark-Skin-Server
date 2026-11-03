import type { FastifyInstance } from 'fastify';

export function registerSecurityHeaders(app: FastifyInstance, production: boolean): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Keep inline/custom scripts functional while enforcing embedding restrictions.
    reply.header('Content-Security-Policy', "base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
    if (production && request.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (reply.statusCode === 503) reply.header('Retry-After', '1');
    return payload;
  });
}
