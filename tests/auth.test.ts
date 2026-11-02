import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/services/cipher.js';
import { serializeSession, parseSession, csrfToken, checkCsrf } from '../src/services/session.js';
import { mapOAuthUser, buildAuthorizeUrl, NATAYARK_ID_PRESET, validateProvider } from '../src/services/oauth-client.js';
import { safeAuthRedirect } from '../src/routes/auth.js';
import { enabledPluginNames,configurePlugin } from '../src/services/plugins.js';
import { compileLegacyPattern } from '../src/util.js';

test('legacy plugin object arrays and PHP-delimited player rules keep their meaning',()=>{
  assert.deepEqual(enabledPluginNames('[{"name":"single-player-limit","version":"3.0"},{"name":"gravatar"}]'),['single-player-limit','gravatar']);
  assert.deepEqual(enabledPluginNames('{"share-registration-link":{"version":"2"},"disabled":false}'),['share-registration-link']);
  assert.deepEqual(enabledPluginNames('["oauth","gravatar"]'),['oauth','gravatar']);
  assert.equal(compileLegacyPattern('/^[a-z_]+$/i')?.test('Player_'),true);
  assert.equal(compileLegacyPattern('/^[a-z]+$/D')?.test('abc\n'),false);
  assert.equal(compileLegacyPattern('/[invalid/'),null);
  assert.equal(compileLegacyPattern('/abc/e'),null);
});

test('single-player settings preserve other plugins and legacy version metadata',()=>{
  const plugins=[{name:'single-player-limit',version:'3.0',enabled:false},{name:'gravatar',version:'1.0'},'oauth'];
  const enabled=configurePlugin(plugins,'single-player-limit',true);
  assert.deepEqual(configurePlugin(enabled,'single-player-limit',true),enabled,'Unchanged settings retain order and metadata');
  assert.deepEqual(enabled,[plugins[1],'oauth',{name:'single-player-limit',version:'3.0',enabled:true}]);
  assert.deepEqual(configurePlugin(enabled,'single-player-limit',false),[plugins[1],'oauth']);
  assert.deepEqual(configurePlugin({'single-player-limit':false,oauth:{version:'1.0'}},'single-player-limit',true),{'single-player-limit':true,oauth:{version:'1.0'}});
  assert.throws(()=>configurePlugin('broken JSON','single-player-limit',true));
});

test('all legacy digest ciphers preserve PHP vectors and reject wrong passwords', async () => {
  const previous = { method: process.env.PWD_METHOD, salt: process.env.SALT };
  const vectors = {
    MD5: '5f4dcc3b5aa765d61d8327deb882cf99',
    SHA256: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    SHA512: 'b109f3bbbc244eb82441917ed06d618b9008dd09b3befd1b5e07394c706a8bb980b1d7785e5976ec049b46df5f1326af5a2ea6d103fd07c95385ffab0cacbc86',
    SALTED2MD5: 'd514dee5e76bbb718084294c835f312c',
    SALTED2SHA256: '92d690d4eb4a598d5362f7196dba110e3974a9ea58eb9363be73e987d738afc6',
    SALTED2SHA512: '0a610f0bbf7a92accc7e962c53ef3ed7d7d2cabb16139ae169555a6685056b405fa4a3edb041f27e6d8c29bea70eb9bd89bad9fcfcdf05e23b1b8b99ad1256a5',
  };
  try {
    process.env.SALT = 'salt';
    for (const [method, expected] of Object.entries(vectors)) {
      process.env.PWD_METHOD = method;
      assert.equal(await hashPassword('password'), expected, method);
      assert.equal(verifyPassword('password', expected), true, method);
      assert.equal(verifyPassword('incorrect', expected), false, method);
    }
    for (const method of ['BCRYPT', 'PHP_PASSWORD_HASH', 'ARGON2I']) {
      process.env.PWD_METHOD = method;
      const hash = await hashPassword('password');
      assert.equal(verifyPassword('password', hash), true);
      assert.equal(verifyPassword('incorrect', hash), false);
      if (method !== 'ARGON2I') assert.match(hash, /^\$2y\$/);
    }
    assert.equal(verifyPassword('password', '$argon2i$v=19$m=1024,t=2,p=1$AQEBAQEBAQEBAQEBAQEBAQ$ffxVmiukv0IwXD56kXxpcag8AtD+2/yweVSZlaX25MU'), true);
  } finally {
    if (previous.method === undefined) delete process.env.PWD_METHOD; else process.env.PWD_METHOD = previous.method;
    if (previous.salt === undefined) delete process.env.SALT; else process.env.SALT = previous.salt;
  }
});

test('session cookies reject tampering, expiry and future issuance; CSRF binds browser', () => {
  const now = Math.floor(Date.now() / 1000), first = { uid: 0, iat: now, sid: 'a'.repeat(64) };
  const second = { ...first, sid: 'b'.repeat(64) };
  const cookie = serializeSession(first);
  assert.deepEqual(parseSession(cookie), first);
  assert.equal(parseSession(cookie + 'x'), null);
  assert.equal(parseSession(serializeSession({ ...first, iat: now + 120 })), null);
  assert.equal(parseSession(serializeSession({ ...first, iat: now - 8 * 86400 })), null);
  assert.notEqual(csrfToken(first), csrfToken(second));
  assert.equal(checkCsrf({ session: first } as any, csrfToken(first)), true);
  assert.equal(checkCsrf({ session: second } as any, csrfToken(first)), false);
  assert.equal(checkCsrf({ session: null } as any, ''), false);
});

test('OAuth subject is stable and unverified email never becomes a verified assertion', () => {
  const provider = { ...NATAYARK_ID_PRESET, emailVerifiedField: 'data.email_verified' };
  const mapped = mapOAuthUser(provider, { data: { id: 0, username: 'Player', email: 'A@Example.test', email_verified: false } });
  assert.deepEqual(mapped, { id: '0', username: 'Player', email: 'a@example.test', emailVerified: false });
  assert.equal(mapOAuthUser(provider, { data: { email: 'user@example.test' } }), null);
  assert.equal(mapOAuthUser(provider, { data: { id: 'id', email_verified: 'true' } })?.emailVerified, false);
  assert.equal(mapOAuthUser(provider, { data: { id: 'id', email_verified: true } })?.emailVerified, true);
  assert.equal(mapOAuthUser(NATAYARK_ID_PRESET, { data: { id: 1, email: 'u@example.test', email_verified: true } })?.emailVerified, false);
});

test('OAuth authorize uses state and S256; rejects insecure providers and open redirects', () => {
  const provider = { ...NATAYARK_ID_PRESET, pkce: true };
  const url = new URL(buildAuthorizeUrl(provider, 'https://skin.example/callback', 'one-use-state', 'v'.repeat(64)));
  assert.equal(url.searchParams.get('state'), 'one-use-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(validateProvider({ ...provider, tokenUrl: 'http://untrusted.example/token' }), false);
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/\nLocation: evil']) assert.equal(safeAuthRedirect(value), '/user');
  assert.equal(safeAuthRedirect('/user/player?from=login'), '/user/player?from=login');
});
