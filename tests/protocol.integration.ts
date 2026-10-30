import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { SignJWT, jwtVerify, createLocalJWKSet } from 'jose';
import { config } from '../src/config.js';
import { query, queryOne, exec, insert, nowString, pool } from '../src/db.js';
import { registerOidcRoutes, validSharedRedirect, registeredRedirectMatches } from '../src/routes/oidc.js';
import { registerYggdrasilRoutes, YggdrasilError, yggdrasilMetadata } from '../src/routes/yggdrasil.js';
import { createClient, validateScopes, verifyPkce, jwksDocument, issuer, saveGrant, issueTokenBundle, yggcFind } from '../src/services/oidc.js';
import { SCOPES, issueAccessToken, verifyAccessToken, ensureSigningKey, getPrivateKey } from '../src/services/token.js';
import { userUuidFromUid, profileFromUuid, serializeProfile } from '../src/services/profile.js';
import { hashPassword } from '../src/services/cipher.js';

assert.match(config.db.tablePrefix, /^dev_/, 'Protocol integration tests require an isolated dev_ table prefix');
const suffix = crypto.randomBytes(4).toString('hex');
const userIds: number[] = [];
const clientIds: number[] = [];
const playerNames: string[] = [];
const app = Fastify();
await app.register(formbody);
app.decorateReply('view', function (_template: string, model: object) { return this.send(model); });
app.addHook('onRequest', async (request: any) => {
  const uid = Number(request.headers['x-test-user']);
  request.session = Number.isFinite(uid) && uid > 0 ? { uid } : null;
  request.csrfToken = () => 'protocol-test-csrf';
  request.checkCsrf = (value: string) => value === 'protocol-test-csrf';
});
app.setErrorHandler((error: any, _request, reply) => {
  if (error instanceof YggdrasilError) return reply.code(error.statusCode).send({ error: error.errorCode, errorMessage: error.message });
  console.error(error);
  return reply.code(500).send({ error: error.message });
});
await registerOidcRoutes(app);
await registerYggdrasilRoutes(app);
await app.ready();
let checks = 0;
function check(value: unknown, message: string): asserts value { assert.ok(value, message); checks++; }
const scopes = [SCOPES.OPENID, SCOPES.OFFLINE_ACCESS, SCOPES.PROFILE_SELECT, SCOPES.SERVER_JOIN];
const verifier = 'a'.repeat(64);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
async function call(path: string, payload: Record<string, unknown>, uid?: number) {
  return app.inject({ method: 'POST', url: path, headers: { ...(uid ? { 'x-test-user': String(uid) } : {}) }, payload });
}
async function authorization(client: number, profile: string, uid: number, scope = scopes.join(' ')) {
  const target = new URL('http://localhost/connect/authorize');
  for (const [key, value] of Object.entries({ client_id: String(client), redirect_uri: 'http://127.0.0.1:7788/callback', response_type: 'code', scope, state: 'state-123', nonce: 'nonce-123', code_challenge: challenge, code_challenge_method: 'S256' })) target.searchParams.set(key, value);
  const start = await app.inject(target.pathname + target.search);
  check(start.statusCode === 302, `Authorization begins without client secret: ${start.body}`);
  const interaction = start.headers.location!.split('/').pop()!;
  const approval = await call(`/connect/interaction/${interaction}/confirm`, { csrf: 'protocol-test-csrf', selectedProfile: profile }, uid);
  check(approval.statusCode === 302, `Consent produces redirect: ${approval.body}`);
  const callback = new URL(approval.headers.location!);
  check(callback.searchParams.get('state') === 'state-123', 'OAuth state returned unchanged');
  return callback.searchParams.get('code')!;
}
try {
  await ensureSigningKey();
  for (let i = 0; i < 2; i++) {
    const uid = await insert('INSERT INTO users (email,nickname,score,password,ip,last_sign_at,register_at,verified,verification_token) VALUES (?,?,10000,?,?,?, ?,1,?)', [`protocol-${suffix}-${i}@example.invalid`, `P${suffix}${i}`, await hashPassword('test-password-123'), '127.0.0.1', nowString(), nowString(), '']);
    userIds.push(uid);
    const name = `P${suffix}${i}`;
    playerNames.push(name);
    await exec('INSERT INTO players (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,0,0,?)', [uid, name, nowString()]);
    await exec('INSERT INTO `uuid` (name,uuid) VALUES (?,?)', [name, crypto.randomBytes(16).toString('hex')]);
  }
  const first = (await queryOne<{ uuid: string }>('SELECT uuid FROM `uuid` WHERE name = ?', [playerNames[0]]))!.uuid;
  const second = (await queryOne<{ uuid: string }>('SELECT uuid FROM `uuid` WHERE name = ?', [playerNames[1]]))!.uuid;
  for (const secret of [null, 'confidential-secret']) clientIds.push(await createClient({ name: `Protocol test ${suffix}`, secret, redirects: ['http://127.0.0.1:7788/callback'], ownerId: userIds[0] }));
  check(!validateScopes(`openid ${SCOPES.SERVER_JOIN}`).ok, 'Join requires selected profile scope');
  check(!validateScopes(`openid ${SCOPES.PROFILE_SELECT} ${SCOPES.PROFILE_READ}`).ok, 'Select/read conflict rejected');
  check(verifyPkce(challenge, verifier) && !verifyPkce(challenge, 'short'), 'S256 verifier syntax and digest checked');
  check(validSharedRedirect('http://127.0.0.1:12345/callback') && !validSharedRedirect('http://attacker.invalid/callback'), 'Shared client accepts loopback only for HTTP');
  check(userUuidFromUid(1).length === 32, 'Legacy user UUID has 16 bytes');
  check(registeredRedirectMatches('http://127.0.0.1:7788/callback','http://127.0.0.1:44999/callback') && !registeredRedirectMatches('https://example.invalid:7788/callback','https://example.invalid:44999/callback') && !registeredRedirectMatches('http://127.0.0.1/callback','http://127.0.0.1:44999/another'), 'Native callbacks vary only the loopback port');
  const discovery=(await app.inject('/.well-known/openid-configuration')).json();
  check(['issuer','jwks_uri','token_endpoint','userinfo_endpoint','authorization_endpoint'].every(key=>typeof discovery[key]==='string') && [SCOPES.OPENID,SCOPES.PROFILE_SELECT,SCOPES.SERVER_JOIN].every(scope=>discovery.scopes_supported.includes(scope)) && discovery.id_token_signing_alg_values_supported.includes('RS256'),'Mandatory Yggdrasil Connect discovery fields present');
  check((await app.inject({method:'POST',url:'/connect/authorize'})).statusCode===400,'Empty authorization POST is a protocol error');
  const posted=await call('/connect/authorize',{client_id:String(clientIds[0]),redirect_uri:'http://127.0.0.1:44999/callback',response_type:'code',scope:scopes.join(' '),code_challenge:challenge,code_challenge_method:'S256'});
  check(posted.statusCode===302&&posted.headers.location?.startsWith('/connect/interaction/'),'Authorization accepts POST and native ephemeral callbacks');
  const badSecret=await app.inject({method:'POST',url:'/connect/token',headers:{authorization:'Basic '+Buffer.from(clientIds[1]+':incorrect').toString('base64')},payload:{grant_type:'authorization_code',code:'invalid'}});
  check(badSecret.statusCode===401&&String(badSecret.headers['www-authenticate']).startsWith('Basic '),'Invalid Basic credentials receive OAuth 401 challenge');

  const confidentialCode = await authorization(clientIds[1], first, userIds[0]);
  const confidential = await call('/connect/token', { grant_type: 'authorization_code', client_id: String(clientIds[1]), client_secret: 'confidential-secret', code: confidentialCode, redirect_uri: 'http://127.0.0.1:7788/callback', code_verifier: verifier });
  check(confidential.statusCode === 200, `Confidential client exchanges code: ${confidential.body}`);

  const code = await authorization(clientIds[0], first, userIds[0]);
  const bad = await call('/connect/token', { grant_type: 'authorization_code', client_id: String(clientIds[0]), code, redirect_uri: 'http://127.0.0.1:7788/callback', code_verifier: 'wrong'.repeat(16) });
  check(bad.statusCode === 400, 'Invalid PKCE rejected without consuming code');
  const exchanges = await Promise.all(Array.from({ length: 4 }, () => call('/connect/token', { grant_type: 'authorization_code', client_id: String(clientIds[0]), code, redirect_uri: 'http://127.0.0.1:7788/callback', code_verifier: verifier })));
  check(exchanges.filter((r) => r.statusCode === 200).length === 1, 'Concurrent authorization code exchange succeeds exactly once');
  const tokens = exchanges.find((r) => r.statusCode === 200)!.json();
  const id = await jwtVerify(tokens.id_token, createLocalJWKSet(await jwksDocument()), { issuer: await issuer(), audience: String(clientIds[0]) });
  check(id.payload.nonce === 'nonce-123' && (id.payload.selectedProfile as any).id === first, 'ID token signature, issuer, audience, nonce and profile are valid');
  const userinfo = await app.inject({ url: '/connect/userinfo', headers: { authorization: `Bearer ${tokens.access_token}` } });
  check(userinfo.statusCode === 200 && userinfo.json().selectedProfile.id === first, 'UserInfo returns bound profile');
  const userinfoPost=await app.inject({method:'POST',url:'/userinfo',headers:{authorization:`Bearer ${tokens.access_token}`}});
  check(userinfoPost.statusCode===200&&userinfoPost.json().sub===id.payload.sub&&userinfoPost.headers['cache-control']==='no-store','POST UserInfo matches ID token subject and is not cached');
  const formInfo=await app.inject({method:'POST',url:'/yggc/userinfo',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({access_token:tokens.access_token}).toString()});
  check(formInfo.statusCode===200&&formInfo.json().selectedProfile.id===first,'Legacy UserInfo accepts form bearer transport');
  const duplicateInfo=await app.inject({method:'POST',url:'/connect/userinfo',headers:{authorization:`Bearer ${tokens.access_token}`,'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({access_token:tokens.access_token}).toString()});
  check(duplicateInfo.statusCode===400&&duplicateInfo.json().error==='invalid_request','Duplicate bearer transports rejected');
  const refreshes = await Promise.all(Array.from({ length: 3 }, () => call('/connect/token', { grant_type: 'refresh_token', client_id: String(clientIds[0]), refresh_token: tokens.refresh_token })));
  check(refreshes.filter((r) => r.statusCode === 200).length === 1, 'Concurrent refresh rotates exactly once');
  const refreshed = refreshes.find((r) => r.statusCode === 200)!.json();
  check((await verifyAccessToken(refreshed.access_token))?.selectedProfile === first, 'Refresh preserves role binding');
  check(await verifyAccessToken(tokens.access_token) === null, 'Rotation revokes prior access token');
  const escalation=await call('/connect/token',{grant_type:'refresh_token',client_id:String(clientIds[0]),refresh_token:refreshed.refresh_token,scope:scopes.concat(SCOPES.EMAIL).join(' ')});
  check(escalation.statusCode===400&&escalation.json().error==='invalid_scope'&&await verifyAccessToken(refreshed.access_token)!==null,'Scope escalation does not consume a valid refresh token');
  const noJoin=await issueTokenBundle({clientId:String(clientIds[0]),accountId:userIds[0],scopes:[SCOPES.OPENID,SCOPES.PROFILE_SELECT],selectedProfile:first,grantId:null},false);
  check((await call('/api/yggdrasil/sessionserver/session/minecraft/join',{accessToken:noJoin.access_token.jwt,selectedProfile:first,serverId:'without-permission'})).statusCode===403,'Selected profile alone does not grant Server.Join');
  const readOnly=await issueTokenBundle({clientId:String(clientIds[0]),accountId:userIds[0],scopes:[SCOPES.OPENID,SCOPES.PROFILE_READ],selectedProfile:null,grantId:null},false);
  const readClaims=(await jwtVerify(readOnly.id_token!,createLocalJWKSet(await jwksDocument()),{issuer:await issuer(),audience:String(clientIds[0])})).payload;
  check(Array.isArray(readClaims.availableProfiles)&&!readClaims.selectedProfile&&!(readClaims.availableProfiles as any[])[0].properties,'Read scope publishes profiles without texture properties or selectedProfile');

  const started = await call('/connect/device_authorize', { client_id: String(clientIds[0]), scope: scopes.join(' ') });
  check(started.statusCode === 200 && started.headers['cache-control']==='no-store', `Device authorization created without caching: ${started.body}`);
  const device = started.json();
  const pending = await call('/connect/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: String(clientIds[0]), device_code: device.device_code });
  check(pending.json().error === 'authorization_pending', 'Device waits for consent');
  const fastPoll = await call('/connect/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: String(clientIds[0]), device_code: device.device_code });
  check(fastPoll.json().error === 'slow_down', 'Fast device polling increases interval');
  const linked = await call('/connect/device/link', { user_code: device.user_code, csrf: 'protocol-test-csrf' }, userIds[0]);
  check(linked.statusCode === 302, 'Device user code links to consent');
  const approved = await call(`${linked.headers.location}/confirm`, { selectedProfile: first, csrf: 'protocol-test-csrf' }, userIds[0]);
  check(approved.statusCode === 200, 'Device consent approved');
  await exec("UPDATE yggc_device_codes SET payload=JSON_SET(payload,'$.lastPoll',0) WHERE id=?", [device.device_code]);
  const deviceTokens = await call('/connect/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: String(clientIds[0]), device_code: device.device_code });
  check(deviceTokens.statusCode === 200, `Approved device code exchanges: ${deviceTokens.body}`);

  const auth = await call('/api/yggdrasil/authserver/authenticate', { username: playerNames[0], password: 'test-password-123', clientToken: 'custom-client-token', requestUser: true });
  check(auth.statusCode === 200 && auth.json().selectedProfile.id === first, `Classic role login binds profile: ${auth.body}`);
  const classic = auth.json();
  const wrongClient = await call('/api/yggdrasil/authserver/validate', { accessToken: classic.accessToken, clientToken: 'wrong' });
  check(wrongClient.statusCode === 403, 'Classic clientToken mismatch rejected');
  const join = await call('/api/yggdrasil/sessionserver/session/minecraft/join', { accessToken: classic.accessToken, selectedProfile: first, serverId: '-123test' });
  check(join.statusCode === 204, `Authenticated join accepted: ${join.body}`);
  const joined = await app.inject(`/api/yggdrasil/sessionserver/session/minecraft/hasJoined?username=${playerNames[0]}&serverId=-123test`);
  check(joined.statusCode === 200 && joined.json().properties[0].signature, 'hasJoined returns signed textures');
  const foreignJoin = await call('/api/yggdrasil/sessionserver/session/minecraft/join', { accessToken: classic.accessToken, selectedProfile: second, serverId: 'wrong-profile' });
  check(foreignJoin.statusCode === 403, 'Foreign profile join rejected');
  const metadata = await yggdrasilMetadata();
  check(metadata.meta['feature.openid_configuration_url'].includes('/.well-known/openid-configuration') && typeof metadata.meta.links === 'object', 'Authlib metadata advertises Connect in meta');
  const signed = await serializeProfile((await profileFromUuid(first))!, false);
  const texturePayload = signed.properties[0];
  check(crypto.verify('sha1', Buffer.from(texturePayload.value), metadata.signaturePublickey, Buffer.from(texturePayload.signature, 'base64')), 'Texture signature validates with advertised legacy key');
  const revoked = await call('/connect/revoke', { client_id: String(clientIds[0]), token: refreshed.refresh_token });
  check(revoked.statusCode === 200 && await verifyAccessToken(refreshed.access_token) === null, 'RFC 7009 revokes matching client token pair');
  console.log(`Protocol integration: ${checks} checks passed`);
} finally {
  for (const client of clientIds) {
    await exec('DELETE r FROM oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id=r.access_token_id WHERE a.client_id=?', [client]);
    await exec('DELETE FROM oauth_access_tokens WHERE client_id=?', [client]);
    await exec('DELETE FROM oauth_clients WHERE id=?', [client]);
    for (const table of ['yggc_authorization_codes','yggc_device_codes','yggc_interactions','yggc_grants','yggc_refresh_tokens']) await exec(`DELETE FROM ${table} WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.clientId'))=? OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.params.client_id'))=?`, [String(client),String(client)]);
  }
  for (const uid of userIds) {
    await exec('DELETE r FROM oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id=r.access_token_id WHERE a.user_id=?', [uid]);
    await exec('DELETE FROM oauth_access_tokens WHERE user_id=?', [uid]);
    await exec('DELETE FROM ygg_log WHERE user_id=?', [uid]);
    await exec('DELETE FROM players WHERE uid=?', [uid]);
    await exec('DELETE FROM users WHERE uid=?', [uid]);
  }
  for (const name of playerNames) await exec('DELETE FROM `uuid` WHERE name=?', [name]);
  await app.close();
  await pool.end();
}
