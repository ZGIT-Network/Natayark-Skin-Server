import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, queryOne, pool } from '../src/db.js';
import { getOption, setOption } from '../src/services/option.js';
import { registerUser } from '../src/services/user.js';
import { setSessionCookie } from '../src/services/session.js';
import { registerUploadLimits, textureParts } from '../src/services/upload-limits.js';

test('authenticated multipart uploads enforce file and envelope limits while reading', { skip: !config.db.tablePrefix.startsWith('dev_') }, async () => {
  const previous = await getOption('max_upload_file_size', '1024');
  const account = await registerUser({ email: 'upload-limits-' + crypto.randomBytes(5).toString('hex') + '@example.test', player_name: 'Limit' + crypto.randomBytes(4).toString('hex'), password: 'upload-limits-fixture', verified: true });
  assert.ok(account.ok);
  const app = await createApp();
  let cookie = '';
  await setSessionCookie({ setCookie(key: string, value: string) { cookie = key + '=' + value; } } as any, account.user.uid);
  const page = await app.inject({ url: '/user', headers: { cookie } });
  const csrf = /window\.__CSRF\s*=\s*"([^"]+)"/.exec(page.body)?.[1]; assert.ok(csrf);
  const boundary = 'security-fixture-boundary';
  const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const file = (data: Buffer) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`), data, Buffer.from('\r\n')]);
  const send = (data: Buffer, twice = false) => app.inject({ method: 'POST', url: '/api/skinlib', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([field('csrf', csrf), field('name', 'fixture'), field('public', '1'), file(data), ...(twice ? [file(data)] : []), Buffer.from(`--${boundary}--\r\n`)]) });
  try {
    await setOption('max_upload_file_size', '1');
    assert.equal((await send(Buffer.alloc(1025))).statusCode, 413, 'business file limit is enforced by the stream parser');
    const png = new PNG({ width: 64, height: 64 }); png.data.set([5, 6, 7, 255]);
    const small = PNG.sync.write(png);
    assert.ok(small.length < 1024);
    assert.equal((await send(small, true)).statusCode, 413, 'a second file is rejected');
    assert.equal((await send(Buffer.alloc(2 * 1024 * 1024))).statusCode, 413, 'oversized request envelope is rejected');
    assert.equal(Number((await queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM textures WHERE uploader=?', [account.user.uid]))?.count), 0, 'rejected bodies have no material side effects');
  } finally {
    await app.close(); await setOption('max_upload_file_size', previous);
    await exec('DELETE FROM players WHERE uid=?', [account.user.uid]); await exec('DELETE FROM users WHERE uid=?', [account.user.uid]);
  }
});

test('upload concurrency is bounded before body parsing and response completion releases slots', { skip: !config.db.tablePrefix.startsWith('dev_'), timeout: 10000 }, async () => {
  const app = Fastify();
  registerUploadLimits(app);
  await app.register(multipart);
  let entered = 0, notify!: () => void, finish!: () => void;
  const busy = new Promise<void>(resolve => { notify = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  app.post('/api/skinlib', async (request, reply) => {
    entered++; if (entered === 2) notify();
    await gate;
    for await (const part of await textureParts(request)) if (part.type === 'file') await part.toBuffer();
    return reply.code(204).send();
  });
  const request = () => app.inject({ method: 'POST', url: '/api/skinlib', headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n\r\nx\r\n--x--\r\n' });
  const first = request(), second = request();
  try {
    await busy;
    const overloaded = await request();
    assert.equal(overloaded.statusCode, 503); assert.equal(overloaded.headers['retry-after'], '1');
    finish();
    assert.equal((await first).statusCode, 204); assert.equal((await second).statusCode, 204);
    assert.equal((await request()).statusCode, 204);
  } finally { finish(); await app.close(); }
});

test.after(async () => { await pool.end(); });
