import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { config } from '../src/config.js';
import { exec, insert, nowString, pool, queryOne } from '../src/db.js';
import { registerOidcRoutes } from '../src/routes/oidc.js';
import { createClient, issueTokenBundle, yggcFind, yggcUpsert } from '../src/services/oidc.js';
import { SCOPES, verifyAccessToken } from '../src/services/token.js';

/** Delay the database commit itself, not the HTTP client or its assertions. */
function interceptNextCommit(fail = false) {
  const original = pool.getConnection;
  let entered!: () => void, release!: () => void, finished!: () => void, used = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  pool.getConnection = async () => {
    const connection = await original.call(pool);
    return new Proxy(connection, {
      get(target, key) {
        if (key === 'commit') return async () => {
          if (used) return target.commit();
          used = true; entered();
          try {
            await gate;
            if (fail) throw new Error('Fixture commit failure');
            await target.commit();
          } finally { finished(); }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { started, release() { release(); if (!used) finished(); }, done, restore() { pool.getConnection = original; } };
}

async function reachedCommit(started: Promise<void>) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([started, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Request did not reach COMMIT')), 5000); })]);
  } finally { clearTimeout(timeout); }
}

test('OIDC responses wait for transaction commit', { skip: !config.db.tablePrefix.startsWith('dev_'), timeout: 30000 }, async t => {
  const app = Fastify();
  let uid = 0, clientId = 0;
  app.decorateReply('view', function (_template: string, model: object) { return this.send(model); });
  app.addHook('onRequest', async request => {
    request.session = { uid, iat: Math.floor(Date.now() / 1000), sid: 'commit-fixture' };
    request.csrfToken = () => 'commit-fixture';
    request.checkCsrf = token => token === 'commit-fixture';
  });
  await registerOidcRoutes(app);
  const suffix = crypto.randomBytes(5).toString('hex');
  async function committedRequest(url: string, payload: object, fail: boolean, beforeCommit: () => Promise<void>) {
    const barrier = interceptNextCommit(fail);
    let settled = false;
    const response = app.inject({ method: 'POST', url, payload }).then(value => { settled = true; return value; });
    try {
      await reachedCommit(barrier.started);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'HTTP response escaped before COMMIT completed');
      await beforeCommit();
    } finally {
      barrier.release(); barrier.restore(); await barrier.done;
    }
    return response;
  }
  try {
    uid = await insert('INSERT INTO users (email,nickname,score,password,ip,last_sign_at,register_at,verified,verification_token) VALUES (?,?,0,?,?,?,?,1,?)', ['commit-' + suffix + '@example.test', 'Commit fixture', '', '127.0.0.1', nowString(), nowString(), '']);
    clientId = await createClient({ name: 'Commit fixture ' + suffix, secret: null, redirects: ['http://127.0.0.1:7788/callback'], ownerId: uid });
    const pair = () => issueTokenBundle({ clientId: String(clientId), accountId: uid, scopes: [SCOPES.OPENID, SCOPES.OFFLINE_ACCESS], selectedProfile: null, grantId: null }, true);

    for (const fail of [false, true]) await t.test(fail ? 'failed revocation commit rolls back and returns an error' : 'revocation success is observable immediately after the response', async () => {
      const tokens = await pair();
      const result = await committedRequest('/connect/revoke', { client_id: String(clientId), token: tokens.refresh_token }, fail, async () => {
        assert.ok(await verifyAccessToken(tokens.access_token.jwt), 'another connection still sees the uncommitted token');
      });
      assert.equal(result.statusCode, fail ? 500 : 200);
      assert.equal((await verifyAccessToken(tokens.access_token.jwt)) === null, !fail);
      assert.equal((await queryOne<{ revoked: number }>('SELECT revoked FROM oauth_refresh_tokens WHERE id=?', [tokens.refresh_token]))?.revoked, fail ? 0 : 1);
    });

    for (const grant of ['authorization_code', 'refresh_token', 'device_code']) for (const fail of [false, true]) {
      await t.test(`${grant}: ${fail ? 'commit failure exposes no tokens and preserves state' : 'new tokens are valid when the response arrives'}`, async () => {
        const id = crypto.randomBytes(24).toString('hex');
        const payload: Record<string, unknown> = { client_id: String(clientId), grant_type: grant };
        let previous: Awaited<ReturnType<typeof pair>> | undefined;
        if (grant === 'authorization_code') {
          await yggcUpsert('yggc_authorization_codes', id, { clientId: String(clientId), accountId: uid, scope: [SCOPES.OPENID, SCOPES.OFFLINE_ACCESS], selectedProfile: null, grantId: null, redirectUri: 'http://127.0.0.1:7788/callback', codeChallenge: '', expiresAt: Math.floor(Date.now() / 1000) + 600 });
          payload.code = id; payload.redirect_uri = 'http://127.0.0.1:7788/callback';
        } else if (grant === 'device_code') {
          await yggcUpsert('yggc_device_codes', id, { clientId: String(clientId), accountId: uid, scope: SCOPES.OPENID + ' ' + SCOPES.OFFLINE_ACCESS, status: 'approved', selectedProfile: null, grantId: null, expiresAt: Math.floor(Date.now() / 1000) + 600 });
          payload.grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; payload.device_code = id;
        } else {
          previous = await pair(); payload.refresh_token = previous.refresh_token;
        }
        const table = grant === 'authorization_code' ? 'yggc_authorization_codes' : 'yggc_device_codes';
        const result = await committedRequest('/connect/token', payload, fail, async () => {
          if (previous) assert.ok(await verifyAccessToken(previous.access_token.jwt));
          else assert.equal((await yggcFind(table, id))?.consumed, 0);
        });
        assert.equal(result.statusCode, fail ? 500 : 200);
        const body = result.json();
        if (fail) assert.equal(body.access_token, undefined);
        else {
          assert.ok(await verifyAccessToken(body.access_token));
          assert.equal((await queryOne<{ revoked: number }>('SELECT revoked FROM oauth_refresh_tokens WHERE id=?', [body.refresh_token]))?.revoked, 0);
        }
        if (previous) assert.equal((await verifyAccessToken(previous.access_token.jwt)) === null, !fail);
        else assert.equal((await yggcFind(table, id))?.consumed, fail ? 0 : 1);
      });
    }

    for (const device of [false, true]) for (const decision of ['confirm', 'deny']) for (const fail of [false, true]) {
      await t.test(`${device ? 'device' : 'browser'} ${decision}: ${fail ? 'failed commit preserves the pending interaction' : 'response follows committed consent state'}`, async () => {
        const interaction = crypto.randomUUID(), deviceId = crypto.randomBytes(24).toString('hex');
        if (device) await yggcUpsert('yggc_device_codes', deviceId, { clientId: String(clientId), status: 'pending', expiresAt: Math.floor(Date.now() / 1000) + 600 });
        await yggcUpsert('yggc_interactions', interaction, { kind: device ? 'device' : 'code', createdAt: Math.floor(Date.now() / 1000), ...(device ? { deviceCodeId: deviceId } : {}), params: { client_id: String(clientId), redirect_uri: 'http://127.0.0.1:7788/callback', scope: SCOPES.OPENID, state: 'commit-fixture' } });
        const result = await committedRequest(`/connect/interaction/${interaction}/${decision}`, { csrf: 'commit-fixture' }, fail, async () => {
          assert.ok(await yggcFind('yggc_interactions', interaction));
          if (device) assert.equal((await yggcFind('yggc_device_codes', deviceId))?.payload.status, 'pending');
        });
        assert.equal(result.statusCode, fail ? 500 : device ? 200 : 302);
        assert.equal((await yggcFind('yggc_interactions', interaction)) === null, !fail);
        if (device) assert.equal((await yggcFind('yggc_device_codes', deviceId))?.payload.status, fail ? 'pending' : decision === 'confirm' ? 'approved' : 'denied');
        else if (!fail) {
          const location = new URL(result.headers.location!);
          if (decision === 'confirm') assert.ok(await yggcFind('yggc_authorization_codes', location.searchParams.get('code')!));
          else assert.equal(location.searchParams.get('error'), 'access_denied');
        } else assert.equal(result.headers.location, undefined);
      });
    }
  } finally {
    await app.close();
    if (clientId) {
      await exec('DELETE r FROM oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id=r.access_token_id WHERE a.client_id=?', [clientId]);
      for (const table of ['yggc_refresh_tokens', 'yggc_authorization_codes', 'yggc_device_codes', 'yggc_interactions', 'yggc_grants']) {
        await exec(`DELETE FROM ${table} WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.clientId'))=? OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.params.client_id'))=?`, [String(clientId), String(clientId)]);
      }
      await exec('DELETE FROM oauth_access_tokens WHERE client_id=?', [clientId]);
      await exec('DELETE FROM oauth_clients WHERE id=?', [clientId]);
    }
    if (uid) await exec('DELETE FROM users WHERE uid=?', [uid]);
    await pool.end();
  }
});
