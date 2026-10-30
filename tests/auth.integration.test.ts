import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, query, queryOne, pool, nowString } from '../src/db.js';
import { getOption, setOption } from '../src/services/option.js';
import { tokenHash } from '../src/services/session.js';
import { checkUserPassword } from '../src/services/user.js';

test('isolated authentication: registration, OAuth, mailbox proof, reset and revocation', { timeout: 60_000, skip: !config.db.tablePrefix.startsWith('dev_') }, async (t) => {
  assert.ok(config.db.tablePrefix.startsWith('dev_'), 'Tests require an isolated dev_ namespace');
  const originalProviders = await getOption('oauth_providers', '');
  const originalLocalLogin = await getOption('local_login_enabled', 'true');
  const originalAuthserver = await getOption('ygg_disable_authserver', 'false');
  await setOption('local_login_enabled','true');
  await setOption('ygg_disable_authserver','false');
  const originalMail = { ...config.mail };
  const suffix = Date.now().toString(36);
  const userEmails: string[] = [];
  const capturedMail: string[] = [];
  let remote: any = {};
  let lastVerifier = '';
  const oauth = http.createServer(async (req, res) => {
    if (req.url === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      lastVerifier = form.get('code_verifier') || '';
      if (form.get('client_secret') !== 'test-secret' || !lastVerifier) { res.writeHead(400); res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ access_token: 'mock-oauth-token' }));
    } else if (req.url === '/userinfo' && req.headers.authorization === 'Bearer mock-oauth-token') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(remote));
    } else { res.writeHead(404); res.end(); }
  });
  const smtp = net.createServer(socket => {
    socket.setEncoding('utf8'); socket.write('220 localhost test SMTP\r\n');
    let buffer = '', inData = false;
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          capturedMail.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); inData = false;
          socket.write('250 Message accepted\r\n'); continue;
        }
        const end = buffer.indexOf('\r\n'); if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 OK\r\n');
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 End with dot\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.end('221 Bye\r\n'); return; }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await Promise.all([new Promise<void>(resolve => oauth.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve))]);
  const oauthPort = (oauth.address() as net.AddressInfo).port, smtpPort = (smtp.address() as net.AddressInfo).port;
  const base = 'http://127.0.0.1:' + oauthPort;
  const provider = { key: 'auth-test', displayName: 'Auth Test', authUrl: base + '/authorize', tokenUrl: base + '/token', userUrl: base + '/userinfo', clientId: 'test-client', clientSecret: 'test-secret', emailVerifiedField: 'email_verified' };
  await setOption('oauth_providers', JSON.stringify([provider]));
  const app = await createApp();
  let browserNumber = 0;
  function browser() {
    const cookies = new Map<string, string>(), address = '192.0.2.' + (++browserNumber);
    return {
      cookies,
      async request(url: string, payload?: Record<string, string>) {
        const response = await app.inject({ url, method: payload ? 'POST' : 'GET', remoteAddress: address,
          headers: { cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '), ...(payload ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
          payload: payload ? new URLSearchParams(payload).toString() : undefined });
        const raw = response.headers['set-cookie'];
        for (const value of raw ? (Array.isArray(raw) ? raw : [String(raw)]) : []) {
          const pair = value.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return response;
      },
      async csrf(path = '/auth/login') {
        const response = await this.request(path);
        assert.equal(response.statusCode, 200, response.body.slice(0, 300));
        const value = /name="csrf" value="([^"]+)"/.exec(response.body)?.[1];
        assert.ok(value, 'CSRF token rendered on ' + path); return value;
      },
    };
  }
  function lastMailToken(): string {
    const decoded = capturedMail.at(-1)!.replace(/=\r\n/g, '').replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(decoded)?.[1];
    assert.ok(token, 'Email contains verification token'); return token;
  }
  async function begin(client: ReturnType<typeof browser>) {
    const response = await client.request('/auth/login/auth-test');
    assert.equal(response.statusCode, 302, response.body);
    const location = new URL(String(response.headers.location));
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    return { state: location.searchParams.get('state')!, challenge: location.searchParams.get('code_challenge')! };
  }
  const local = browser(), email = 'auth-local-' + suffix + '@example.test', playerName = 'Auth' + suffix;
  userEmails.push(email);
  let uid = 0, localCsrf = '';
  try {
    await t.test('anonymous CSRF tokens differ; public protocol requests create no cookies or session rows', async () => {
      const one = await local.csrf('/auth/register'), two = await browser().csrf('/auth/register');
      assert.notEqual(one, two);
      const response = await app.inject('/api/yggdrasil');
      assert.equal(response.headers['set-cookie'], undefined);
      const rows = await query<{ c: number }>('SELECT COUNT(*) AS c FROM mcn_web_sessions WHERE user_id IS NULL');
      assert.equal(Number(rows[0].c), 0);
    });
    await t.test('registration creates free initial player and first sign-in awards once under concurrency', async () => {
      const csrf = await local.csrf('/auth/register');
      const response = await local.request('/auth/register', { csrf, email, password: 'Auth-password-123', password_confirm: 'Auth-password-123', player_name: playerName });
      assert.equal(response.statusCode, 302, response.body);
      const user = await queryOne<any>('SELECT * FROM users WHERE email = ?', [email]);
      assert.ok(user); uid = user.uid;
      assert.equal(user.score, Number(await getOption('user_initial_score', '1000')));
      assert.equal((await queryOne<any>('SELECT COUNT(*) AS c FROM players WHERE uid = ?', [uid]))?.c, 1);
      localCsrf = await local.csrf('/user/profile');
      const attempts = await Promise.all([local.request('/user/sign', { csrf: localCsrf }), local.request('/user/sign', { csrf: localCsrf })]);
      assert.deepEqual(attempts.map(r => r.statusCode).sort(), [200, 400]);
    });
    await t.test('CSRF blocks profile mutations and set-password requires the existing password', async () => {
      assert.equal((await local.request('/user/profile', { action: 'nickname', nickname: 'attacker' })).statusCode, 403);
      const before = (await queryOne<any>('SELECT password FROM users WHERE uid = ?', [uid]))!.password;
      assert.equal((await local.request('/auth/oauth/set-password', { csrf: localCsrf, password: 'new-password-123' })).statusCode, 400);
      assert.equal((await queryOne<any>('SELECT password FROM users WHERE uid = ?', [uid]))!.password, before);
    });
    await t.test('disabled SMTP never discloses a reset link or creates a reset token', async () => {
      config.mail.host = ''; config.mail.fromAddress = '';
      const anonymous = browser(), csrf = await anonymous.csrf('/auth/forgot');
      const response = await anonymous.request('/auth/forgot', { csrf, email });
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /\/auth\/reset\/\d+\?token=/);
      assert.equal((await queryOne<any>('SELECT COUNT(*) AS c FROM mcn_email_challenges WHERE user_id = ? AND purpose = ?', [uid, 'reset']))!.c, 0);
    });
    await t.test('OAuth cannot take over a local account by asserting its email', async () => {
      remote = { id: 'existing-email-' + suffix, username: playerName, email, email_verified: true };
      const anonymous = browser(), flow = await begin(anonymous);
      const response = await anonymous.request('/auth/login/auth-test/callback?code=code&state=' + flow.state);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(crypto.createHash('sha256').update(lastVerifier).digest('base64url'), flow.challenge);
      assert.equal((await anonymous.request('/user')).statusCode, 302);
    });
    await t.test('state binds the initiating browser and callback is single-use; verified provider can register', async () => {
      const oauthEmail = 'auth-oauth-' + suffix + '@example.test'; userEmails.push(oauthEmail);
      remote = { id: 'verified-' + suffix, username: 'OAuth', email: oauthEmail, email_verified: true };
      const anonymous = browser(), flow = await begin(anonymous);
      assert.equal((await browser().request('/auth/login/auth-test/callback?code=code&state=' + flow.state)).statusCode, 400);
      const callback = await anonymous.request('/auth/login/auth-test/callback?code=code&state=' + flow.state);
      assert.equal(callback.statusCode, 302, callback.body);
      assert.equal((await anonymous.request('/auth/login/auth-test/callback?code=code&state=' + flow.state)).statusCode, 400);
      const completeUrl = String(callback.headers.location), token = new URL(completeUrl, 'http://local').searchParams.get('flow')!;
      const csrf = await anonymous.csrf(completeUrl);
      const registration = { csrf, flow: token, email: oauthEmail, player_name: 'Oau' + suffix };
      const missingPassword = await anonymous.request('/auth/oauth/complete',registration);
      assert.match(missingPassword.body,/密码至少/);
      assert.equal(await queryOne('SELECT uid FROM users WHERE email=?',[oauthEmail]),null);
      const mismatch = await anonymous.request('/auth/oauth/complete',{...registration,password:'OAuth-password-123',password_confirm:'different'});
      assert.match(mismatch.body,/两次输入的密码不一致/);
      const response = await anonymous.request('/auth/oauth/complete', { ...registration,password:'OAuth-password-123',password_confirm:'OAuth-password-123' });
      assert.equal(response.statusCode, 302, response.body);
      const account = await queryOne<any>('SELECT uid, password FROM users WHERE email = ?', [oauthEmail]);
      assert.ok(account); assert.ok(checkUserPassword(account,'OAuth-password-123'));
      assert.equal((await queryOne<any>('SELECT user_id FROM mcn_oauth_identities WHERE provider = ? AND subject = ?', ['auth-test', remote.id]))?.user_id, account.uid);
      const connectionsCsrf = await anonymous.csrf('/user/connections');
      try {
        await setOption('local_login_enabled','false');
        await exec('INSERT INTO mcn_oauth_identities (provider,subject,user_id,display_name,created_at) VALUES (?,?,?,?,?)',['removed-provider','unused-'+suffix,account.uid,'Unavailable',nowString()]);
        const unlink = await anonymous.request('/user/connections/auth-test/unlink', { csrf: connectionsCsrf });
        assert.equal(unlink.statusCode,400,'A saved password and an unavailable provider cannot replace the last usable login');
        assert.match(unlink.body,/已关闭邮箱密码登录/);
        assert.equal((await anonymous.request('/auth/login',{csrf:connectionsCsrf,email:oauthEmail,password:'OAuth-password-123'})).statusCode,403);
        const launcher=await app.inject({method:'POST',url:'/api/yggdrasil/authserver/authenticate',payload:{username:oauthEmail,password:'OAuth-password-123',clientToken:'oauth-registration-check'}});
        assert.equal(launcher.statusCode,200,launcher.body);
        assert.equal(launcher.json().selectedProfile.name,'Oau'+suffix);
      } finally { await setOption('local_login_enabled','true'); }
    });
    await t.test('unverified provider email requires mailbox proof before account and identity are created', async () => {
      Object.assign(config.mail, { host: '127.0.0.1', port: smtpPort, secure: false, username: '', password: '', fromAddress: 'noreply@example.test' });
      const oauthEmail = 'auth-mail-' + suffix + '@example.test'; userEmails.push(oauthEmail);
      remote = { id: 'unverified-' + suffix, username: 'Mailbox', email: oauthEmail, email_verified: false };
      const anonymous = browser(), flow = await begin(anonymous);
      const callback = await anonymous.request('/auth/login/auth-test/callback?code=code&state=' + flow.state);
      const completeUrl = String(callback.headers.location), token = new URL(completeUrl, 'http://local').searchParams.get('flow')!;
      const csrf = await anonymous.csrf(completeUrl);
      const response = await anonymous.request('/auth/oauth/complete', { csrf, flow: token, email: oauthEmail, player_name: 'Mai' + suffix,password:'Mailbox-password-123',password_confirm:'Mailbox-password-123' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(await queryOne('SELECT uid FROM users WHERE email = ?', [oauthEmail]), null);
      assert.equal(await queryOne('SELECT user_id FROM mcn_oauth_identities WHERE provider = ? AND subject = ?', ['auth-test', remote.id]), null);
      const pending = await queryOne<any>('SELECT payload FROM mcn_oauth_flows WHERE token_hash=?',[tokenHash(token)]);
      assert.ok(!JSON.stringify(pending).includes('Mailbox-password-123'),'Pending registrations must not persist plaintext passwords');
      const mailToken = lastMailToken();
      assert.equal((await browser().request('/auth/verify-email?token=' + mailToken)).statusCode, 400);
      const verified = await anonymous.request('/auth/verify-email?token=' + mailToken);
      assert.equal(verified.statusCode, 302, verified.body);
      assert.equal((await queryOne<any>('SELECT verified FROM users WHERE email = ?', [oauthEmail]))?.verified, 1);
      assert.ok(checkUserPassword((await queryOne<any>('SELECT * FROM users WHERE email=?',[oauthEmail]))!,'Mailbox-password-123'));
      assert.equal((await anonymous.request('/auth/verify-email?token=' + mailToken)).statusCode, 400);
    });
    await t.test('an authenticated user explicitly links and unlinks a stable external subject', async () => {
      remote = { id: 'linked-' + suffix, username: 'Linked', email: 'different-' + suffix + '@example.test', email_verified: false };
      const response = await local.request('/user/connections/auth-test/link', { csrf: localCsrf });
      assert.equal(response.statusCode, 302, response.body);
      const state = new URL(String(response.headers.location)).searchParams.get('state')!;
      const linked = await local.request('/auth/login/auth-test/callback?code=code&state=' + state);
      assert.equal(linked.statusCode, 302, linked.body);
      assert.equal((await queryOne<any>('SELECT user_id FROM mcn_oauth_identities WHERE provider = ? AND subject = ?', ['auth-test', remote.id]))?.user_id, uid);
      // A provider email change must not change the account selected by its subject.
      remote.email = 'changed-' + suffix + '@example.test';
      const anonymous = browser(), login = await begin(anonymous);
      assert.equal((await anonymous.request('/auth/login/auth-test/callback?code=code&state=' + login.state)).statusCode, 302);
      assert.match((await anonymous.request('/user/profile')).body, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal((await local.request('/user/connections/auth-test/unlink', { csrf: localCsrf })).statusCode, 302);
      assert.equal(await queryOne('SELECT user_id FROM mcn_oauth_identities WHERE provider = ? AND subject = ?', ['auth-test', remote.id]), null);
    });
    await t.test('concurrent unlinks keep one usable provider when website password login is disabled', async () => {
      const second={...provider,key:'auth-test-two'};
      await setOption('oauth_providers',JSON.stringify([provider,second]));
      await setOption('local_login_enabled','false');
      try {
        for(const key of [provider.key,second.key])await exec('INSERT INTO mcn_oauth_identities (provider,subject,user_id,display_name,created_at) VALUES (?,?,?,?,?)',[key,'parallel-'+suffix,uid,'Parallel',nowString()]);
        const csrf=await local.csrf('/user/connections');
        const results=await Promise.all([provider.key,second.key].map(key=>local.request('/user/connections/'+key+'/unlink',{csrf})));
        assert.equal(results.filter(result=>String(result.headers.location).includes('notice=unlinked')).length,1);
        assert.equal((await queryOne<any>('SELECT COUNT(*) c FROM mcn_oauth_identities WHERE user_id=?',[uid])).c,1);
      } finally {
        await exec('DELETE FROM mcn_oauth_identities WHERE user_id=?',[uid]);
        await setOption('local_login_enabled','true');
        await setOption('oauth_providers',JSON.stringify([provider]));
      }
    });
    await t.test('reset is hashed, expires and is single-use, and invalidates existing browser sessions', async () => {
      const anonymous = browser(), csrf = await anonymous.csrf('/auth/forgot');
      const response = await anonymous.request('/auth/forgot', { csrf, email });
      assert.equal(response.statusCode, 200, response.body);
      const token = lastMailToken(), path = '/auth/reset/' + uid + '?token=' + token;
      const stored = await queryOne<any>('SELECT token_hash FROM mcn_email_challenges WHERE user_id = ? AND purpose = ?', [uid, 'reset']);
      assert.equal(stored.token_hash, tokenHash(token)); assert.notEqual(stored.token_hash, token);
      const resetCsrf = await anonymous.csrf(path);
      const changed = await anonymous.request('/auth/reset/' + uid, { csrf: resetCsrf, token, password: 'Changed-password-123' });
      assert.equal(changed.statusCode, 302, changed.body);
      assert.equal((await local.request('/user')).statusCode, 302, 'Pre-reset session is revoked');
      assert.equal((await anonymous.request(path)).body.includes('重置链接无效或已过期'), true);
      const expiredToken = crypto.randomBytes(32).toString('base64url');
      await exec('INSERT INTO mcn_email_challenges (token_hash,purpose,user_id,payload,created_at,expires_at) VALUES (?, ?, ?, ?, ?, ?)', [tokenHash(expiredToken), 'reset', uid, '{}', nowString(-7200), nowString(-1)]);
      assert.match((await anonymous.request('/auth/reset/' + uid + '?token=' + expiredToken)).body, /重置链接无效或已过期/);
      const loginCsrf = await anonymous.csrf('/auth/login');
      assert.equal((await anonymous.request('/auth/login', { csrf: loginCsrf, email, password: 'Changed-password-123' })).statusCode, 302);
      const logoutCsrf = await anonymous.csrf('/auth/logout'), stolen = new Map(anonymous.cookies);
      assert.equal((await anonymous.request('/auth/logout', { csrf: logoutCsrf })).statusCode, 302);
      anonymous.cookies.clear(); for (const [k, v] of stolen) anonymous.cookies.set(k, v);
      assert.equal((await anonymous.request('/user')).statusCode, 302, 'Logged-out cookie cannot be replayed');
    });
  } finally {
    Object.assign(config.mail, originalMail);
    await setOption('local_login_enabled',originalLocalLogin);
    await setOption('ygg_disable_authserver',originalAuthserver);
    await setOption('oauth_providers', originalProviders);
    for (const email of userEmails) {
      const user = await queryOne<any>('SELECT uid FROM users WHERE email = ?', [email]);
      if (!user) continue;
      await exec('DELETE FROM `uuid` WHERE name IN (SELECT name FROM players WHERE uid = ?)', [user.uid]);
      await exec('DELETE FROM players WHERE uid = ?', [user.uid]);
      await exec('DELETE FROM mcn_web_sessions WHERE user_id = ?', [user.uid]);
      await exec('DELETE FROM mcn_email_challenges WHERE user_id = ?', [user.uid]);
      await exec('DELETE FROM mcn_oauth_identities WHERE user_id = ?', [user.uid]);
      await exec('DELETE r FROM oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id=r.access_token_id WHERE a.user_id=?',[user.uid]);
      await exec('DELETE FROM oauth_access_tokens WHERE user_id=?',[user.uid]);
      await exec('DELETE FROM users WHERE uid = ?', [user.uid]);
    }
    await exec('DELETE FROM mcn_oauth_flows WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, ?)) = ?', ['$.provider', 'auth-test']);
    await app.close();
    await Promise.all([new Promise<void>(resolve => oauth.close(() => resolve())), new Promise<void>(resolve => smtp.close(() => resolve()))]);
    await pool.end();
  }
});
