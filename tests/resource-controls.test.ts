import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { hash as bcryptHash } from '@node-rs/bcrypt';
import { PNG } from 'pngjs';
import { WorkLimit } from '../src/services/work-limit.js';
import { verifyPassword } from '../src/services/cipher.js';
import { formatLocalDate, parseLocalDate } from '../src/services/datetime.js';
import { textureFingerprint } from '../src/services/texture-rewards.js';
import { registerRequestLimits } from '../src/services/request-limits.js';
import { registerSecurityHeaders } from '../src/services/security-headers.js';

test('work queues have a fixed size, hand off slots and release only once', async () => {
  const work = new WorkLimit(1, 1);
  const first = await work.acquire();
  const second = work.acquire();
  await assert.rejects(work.acquire(), { statusCode: 503 });
  first(); first();
  const release = await second;
  const queued = work.acquire();
  await assert.rejects(work.acquire(), { statusCode: 503 });
  release();
  (await queued)();
  const final = await work.acquire(); final();
  await assert.rejects(work.run(async () => { throw new Error('work failed'); }), /work failed/);
  const recovered = await work.acquire(); recovered();
});

test('bcrypt verification allows the event loop to serve other work', async () => {
  const hash = await bcryptHash('fixture-password', { cost: 12, version: '2y' });
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 5);
  try { assert.equal(await verifyPassword('fixture-password', hash), true); }
  finally { clearInterval(timer); }
  assert.ok(heartbeats > 0, 'password verification blocked the main thread');
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('reward fingerprints ignore compression, trailing bytes and invisible RGB', () => {
  const png = new PNG({ width: 64, height: 64 });
  png.data.set([12, 34, 56, 255]);
  const normal = PNG.sync.write(png);
  const uncompressed = PNG.sync.write(png, { deflateLevel: 0 });
  assert.notDeepEqual(normal, uncompressed);
  const identity = textureFingerprint(normal);
  assert.equal(textureFingerprint(uncompressed), identity);
  assert.equal(textureFingerprint(Buffer.concat([normal, Buffer.from('extra bytes after IEND')])), identity);
  png.data.set([1, 2, 3, 0], 4);
  assert.equal(textureFingerprint(PNG.sync.write(png)), identity);
  png.data[0]++;
  assert.notEqual(textureFingerprint(PNG.sync.write(png)), identity);
});

test('local database times use the rules for each date, including DST transitions', () => {
  for (const [utc, local] of [
    ['2026-01-15T12:00:00Z', '2026-01-15 07:00:00'],
    ['2026-07-15T12:00:00Z', '2026-07-15 08:00:00'],
    ['2026-03-08T06:59:59Z', '2026-03-08 01:59:59'],
    ['2026-03-08T07:00:00Z', '2026-03-08 03:00:00'],
    ['2026-11-01T04:59:59Z', '2026-11-01 00:59:59'],
    ['2026-11-01T07:00:00Z', '2026-11-01 02:00:00'],
  ]) {
    assert.equal(formatLocalDate(new Date(utc), 'America/New_York'), local);
    assert.equal(parseLocalDate(local, 'America/New_York'), Date.parse(utc));
  }
  assert.equal(parseLocalDate('2026-11-01 01:30:00', 'America/New_York'), Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(parseLocalDate('2026-03-08 02:30:00', 'America/New_York'), Date.parse('2026-03-08T07:30:00Z'));
  assert.equal(formatLocalDate(new Date('2026-01-15T12:00:00Z'), 'Asia/Shanghai'), '2026-01-15 20:00:00');
  assert.ok(Number.isNaN(parseLocalDate('not-a-date', 'Asia/Shanghai')));
});

test('IP limits cover rotating usernames and token aliases; account limits run after parsing', async () => {
  const previous = process.env.AUTH_IP_RATE_LIMIT;
  process.env.AUTH_IP_RATE_LIMIT = '10';
  const app = Fastify({ rewriteUrl: req => req.url === '/token' ? '/connect/token' : req.url! });
  try {
    await registerRequestLimits(app);
    app.post('/connect/token', async () => ({ ok: true }));
    app.post('/api/yggdrasil/authserver/authenticate', { config: { rateLimit: { hook: 'preHandler', max: 2, timeWindow: '1 minute', keyGenerator: request => String((request.body as any).username) } } }, async () => ({ ok: true }));
    for (let index = 0; index < 10; index++) assert.equal((await app.inject({ method: 'POST', url: '/token', payload: { client_id: String(index) } })).statusCode, 200);
    const blocked = await app.inject({ method: 'POST', url: '/connect/token', payload: {} });
    assert.equal(blocked.statusCode, 429); assert.ok(blocked.headers['retry-after']);
    for (let index = 1; index <= 3; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/yggdrasil/authserver/authenticate', remoteAddress: `192.0.2.${index}`, payload: { username: 'same-account' } });
      assert.equal(response.statusCode, index < 3 ? 200 : 429);
    }
    for (let index = 0; index <= 10; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/yggdrasil/authserver/authenticate', remoteAddress: '192.0.2.20', payload: { username: 'rotating-' + index } });
      assert.equal(response.statusCode, index < 10 ? 200 : 429);
    }
    for (let index = 0; index <= 10; index++) {
      const response = await app.inject({ method: 'POST', url: '/token', remoteAddress: `2001:db8::${index + 1}`, payload: {} });
      assert.equal(response.statusCode, index < 10 ? 200 : 429, 'IPv6 address rotation inside one subnet shares the IP budget');
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_IP_RATE_LIMIT; else process.env.AUTH_IP_RATE_LIMIT = previous;
    await app.close();
  }
});

test('security headers cover HTML, JSON and errors; HSTS requires trusted HTTPS', async () => {
  const app = Fastify({ trustProxy: 'loopback' });
  registerSecurityHeaders(app, true);
  app.get('/page', async (_, reply) => reply.type('text/html').send('<script>window.inlineWorks=true</script>'));
  app.get('/json', async () => ({ ok: true }));
  app.get('/error', async (_, reply) => reply.code(400).send({ error: 'fixture' }));
  try {
    for (const url of ['/page', '/json', '/error']) {
      const response = await app.inject(url);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(response.headers['strict-transport-security'], undefined);
    }
    assert.equal((await app.inject({ url: '/json', headers: { 'x-forwarded-proto': 'https' } })).headers['strict-transport-security'], 'max-age=31536000');
    assert.equal((await app.inject({ url: '/json', remoteAddress: '192.0.2.1', headers: { 'x-forwarded-proto': 'https' } })).headers['strict-transport-security'], undefined);
  } finally { await app.close(); }
});
