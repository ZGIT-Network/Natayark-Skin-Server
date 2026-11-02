import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { config } from '../src/config.js';
import { queryOne, exec, insert, nowString, pool } from '../src/db.js';
import { registerMojangRoutes } from '../src/routes/mojang.js';
import { MojangVerificationError, microsoftVerificationUrl, resolveMinecraftIdentity, bindMinecraftIdentity, synchronizeVerifiedUuid, mojangConfiguration } from '../src/services/mojang.js';
import { findUserByUid } from '../src/services/user.js';
import { getOptionInt, getOption, setOption } from '../src/services/option.js';
assert.match(config.db.tablePrefix, /^dev_/, 'Mojang tests require isolated dev_ tables');
const suffix = crypto.randomBytes(4).toString('hex');
const ids: number[] = [];
const names: string[] = [];
let checks = 0;
function check(value: unknown, message: string): asserts value { assert.ok(value, message); checks++; }
const identity = { uuid: crypto.randomBytes(16).toString('hex'), name: `M${suffix}` };
const settings = { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost:3000/mojang/callback', configured: true, problem: null };
const verifier = 'v'.repeat(64);
const seen: string[] = [];
const successfulResponses = [
  { access_token: 'ms-test-token' }, { Token: 'xbl-test-token' }, { Token: 'xsts-test-token', DisplayClaims: { xui: [{ uhs: 'test-uhs' }] } },
  { access_token: 'mc-test-token' }, { items: [{ name: 'game_minecraft' }] }, { id: identity.uuid, name: identity.name },
];
function fetcherWith(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async (url: any, init: any) => {
    seen.push(String(url));
    if (i === 0) {
      const form = init.body as URLSearchParams;
      check(form.get('code_verifier') === verifier && form.get('client_secret') === settings.clientSecret, 'Code exchange includes PKCE and server-held client secret');
    }
    const entry = responses[i++];
    if (entry instanceof Response) return entry;
    return Response.json(entry);
  }) as typeof fetch;
}
const app = Fastify();
await app.register(formbody);
app.decorateReply('view', function (_template: string, model: object) { return this.send(model); });
app.addHook('onRequest', async (request: any) => {
  const uid = Number(request.headers['x-test-user']);
  request.currentUser = uid ? await findUserByUid(uid) : null;
  request.session = uid ? { uid, sid: request.headers['x-test-sid'] ?? 'a'.repeat(64), iat: Math.floor(Date.now()/1000) } : null;
  request.csrfToken = () => 'csrf-test';
  request.checkCsrf = (value: string) => value === 'csrf-test';
});
await registerMojangRoutes(app);
await app.ready();
const oldKey = process.env.MICROSOFT_KEY, oldSecret = process.env.MICROSOFT_SECRET;
const originalPlugins=await getOption('plugins_enabled','[]'),originalReward=await getOption('mojang_verification_score_award','0'),originalLimit=await getOption('max_players_per_user','0');
try {
  await setOption('mojang_verification_score_award','77');
  await setOption('max_players_per_user','0');
  const login = new URL(microsoftVerificationUrl(settings, 'browser-state', verifier));
  check(login.searchParams.get('code_challenge_method') === 'S256' && login.searchParams.get('state') === 'browser-state' && !login.searchParams.has('client_secret'), 'Microsoft authorization uses state/S256 and keeps secrets off URL');
  const resolved = await resolveMinecraftIdentity(settings, 'test-code', verifier, fetcherWith(successfulResponses));
  check(resolved.uuid === identity.uuid && resolved.name === identity.name && seen.length === 6, 'Microsoft/Xbox/XSTS/Minecraft/ownership/profile chain returns identity');
  await assert.rejects(() => resolveMinecraftIdentity(settings, 'test-code', verifier, fetcherWith([successfulResponses[0], successfulResponses[1], new Response(JSON.stringify({ XErr: 2148916233 }), { status: 401 })])), (e: any) => e instanceof MojangVerificationError && e.code === 'xsts_denied'); checks++;
  await assert.rejects(() => resolveMinecraftIdentity(settings, 'test-code', verifier, fetcherWith([...successfulResponses.slice(0,4), { items: [] }])), (e: any) => e instanceof MojangVerificationError && e.code === 'not_owned'); checks++;
  for (let i=0;i<5;i++) ids.push(await insert('INSERT INTO users(email,nickname,score,password,ip,last_sign_at,register_at,verified,verification_token) VALUES (?,?,500,?,?,?, ?,1,?)', [`mojang-${suffix}-${i}@example.invalid`, `M${suffix}${i}`, '', '127.0.0.1', nowString(), nowString(), '']));
  names.push(identity.name);
  const before = (await queryOne<{ score: number }>('SELECT score FROM users WHERE uid=?', [ids[0]]))!.score;
  const reward = Math.max(0,await getOptionInt('mojang_verification_score_award',0));
  const results = await Promise.all([bindMinecraftIdentity(ids[0],identity),bindMinecraftIdentity(ids[0],identity)]);
  check(results.filter(r=>!r.alreadyVerified).length===1, 'Concurrent binding creates exactly one verification');
  const after = (await queryOne<{ score: number }>('SELECT score FROM users WHERE uid=?', [ids[0]]))!.score;
  check(after-before===reward, 'Verification reward granted exactly once');
  const mapped = await queryOne<{ uuid: string }>('SELECT uuid FROM `uuid` WHERE name=?',[identity.name]);
  check(mapped?.uuid===identity.uuid, 'New verified player receives real UUID');
  await assert.rejects(()=>bindMinecraftIdentity(ids[1],identity), (e:any)=>e instanceof MojangVerificationError&&e.code==='uuid_conflict'); checks++;
  await assert.rejects(()=>bindMinecraftIdentity(ids[2],{...identity,uuid:crypto.randomBytes(16).toString('hex')}), (e:any)=>e instanceof MojangVerificationError&&e.code==='player_conflict'); checks++;
  const oldUuid=crypto.randomBytes(16).toString('hex');
  const legacyName=`L${suffix}`;names.push(legacyName);
  await exec('INSERT INTO players(uid,name,tid_skin,tid_cape,last_modified) VALUES(?,?,0,0,?)',[ids[1],legacyName,nowString()]);
  await exec('INSERT INTO `uuid`(name,uuid) VALUES(?,?)',[legacyName,oldUuid]);
  const realUuid=crypto.randomBytes(16).toString('hex');
  const legacy=await bindMinecraftIdentity(ids[1],{name:legacyName,uuid:realUuid});
  check(!legacy.uuidSynced&&(await queryOne<{uuid:string}>('SELECT uuid FROM `uuid` WHERE name=?',[legacyName]))?.uuid===oldUuid,'Binding preserves existing offline UUID until explicit sync');
  await synchronizeVerifiedUuid(ids[1], (async()=>Response.json({id:realUuid,name:legacyName})) as typeof fetch);
  check((await queryOne<{uuid:string}>('SELECT uuid FROM `uuid` WHERE name=?',[legacyName]))?.uuid===realUuid,'Explicit sync updates only verified owner mapping');
  await setOption('plugins_enabled',JSON.stringify([{name:'single-player-limit',version:'fixture'}]));
  const localName='Local'+suffix,officialName='Real'+suffix,localUuid=crypto.randomBytes(16).toString('hex'),officialUuid=crypto.randomBytes(16).toString('hex');
  names.push(localName,officialName);
  const skin=await insert('INSERT INTO textures(name,type,hash,size,uploader,public,upload_at) VALUES(?,?,?,?,?,1,?)',['Owned skin','steve',crypto.randomBytes(32).toString('hex'),1,ids[3],nowString()]);
  const cape=await insert('INSERT INTO textures(name,type,hash,size,uploader,public,upload_at) VALUES(?,?,?,?,?,1,?)',['Owned cape','cape',crypto.randomBytes(32).toString('hex'),1,ids[3],nowString()]);
  const pid=await insert('INSERT INTO players(uid,name,tid_skin,tid_cape,last_modified) VALUES(?,?,?,?,?)',[ids[3],localName,skin,cape,nowString()]);
  await exec('INSERT INTO `uuid`(name,uuid) VALUES(?,?)',[localName,localUuid]);
  const playerBefore=await queryOne<any>('SELECT * FROM players WHERE pid=?',[pid]);
  const single=await bindMinecraftIdentity(ids[3],{name:officialName,uuid:officialUuid});
  check(!single.uuidSynced&&single.reward===77,'Single-player ownership verification succeeds without creating a second player');
  assert.deepEqual(await queryOne('SELECT * FROM players WHERE pid=?',[pid]),playerBefore);checks++;
  check((await queryOne<{uuid:string}>('SELECT uuid FROM `uuid` WHERE name=?',[localName]))?.uuid===localUuid&&!await queryOne('SELECT id FROM `uuid` WHERE name=?',[officialName]),'First verification retains the original UUID and creates no orphan official mapping');
  await assert.rejects(()=>synchronizeVerifiedUuid(ids[3],(async()=>Response.json({id:officialUuid,name:identity.name})) as typeof fetch),(error:any)=>error instanceof MojangVerificationError&&error.code==='player_conflict');checks++;
  assert.deepEqual(await queryOne('SELECT * FROM players WHERE pid=?',[pid]),playerBefore);checks++;
  await synchronizeVerifiedUuid(ids[3],(async()=>Response.json({id:officialUuid,name:officialName})) as typeof fetch);
  const synchronized=await queryOne<any>('SELECT * FROM players WHERE pid=?',[pid]);
  check(synchronized?.name===officialName&&synchronized.uid===ids[3]&&synchronized.tid_skin===skin&&synchronized.tid_cape===cape,'Explicit synchronization renames the existing player while retaining PID, owner, skin and cape');
  check((await queryOne<{uuid:string}>('SELECT uuid FROM `uuid` WHERE name=?',[officialName]))?.uuid===officialUuid&&!await queryOne('SELECT id FROM `uuid` WHERE name=?',[localName]),'Explicit synchronization migrates the name mapping to the official UUID');
  const repeated=await bindMinecraftIdentity(ids[3],{name:officialName,uuid:officialUuid});
  check(repeated.alreadyVerified&&repeated.reward===0&&(await queryOne<{score:number}>('SELECT score FROM users WHERE uid=?',[ids[3]]))?.score===577,'Repeated verification neither creates another player nor repeats the reward');
  await setOption('plugins_enabled','[]');await setOption('max_players_per_user','2');
  const historicNames=['First'+suffix,'Second'+suffix];names.push(...historicNames);
  for(const name of historicNames)await exec('INSERT INTO players(uid,name,tid_skin,tid_cape,last_modified) VALUES(?,?,0,0,?)',[ids[4],name,nowString()]);
  const historicIdentity={name:'History'+suffix,uuid:crypto.randomBytes(16).toString('hex')};names.push(historicIdentity.name);
  await bindMinecraftIdentity(ids[4],historicIdentity);
  check((await queryOne<{c:number}>('SELECT COUNT(*) c FROM players WHERE uid=?',[ids[4]]))?.c===2&&!await queryOne('SELECT id FROM `uuid` WHERE name=?',[historicIdentity.name]),'Verification honors a configured multi-player cap without creating an extra player or orphan mapping');
  await setOption('plugins_enabled',JSON.stringify([{name:'single-player-limit',version:'fixture'}]));
  await assert.rejects(()=>synchronizeVerifiedUuid(ids[4],(async()=>Response.json({id:historicIdentity.uuid,name:historicIdentity.name})) as typeof fetch),(error:any)=>error instanceof MojangVerificationError&&error.code==='player_conflict');checks++;
  check((await queryOne<{c:number}>('SELECT COUNT(*) c FROM players WHERE uid=?',[ids[4]]))?.c===2,'Historical multi-player accounts are not silently merged or deleted during single-player verification');
  const anonymous=await app.inject('/user/verification');
  check(anonymous.statusCode===302,'Verification page requires login');
  delete process.env.MICROSOFT_KEY;delete process.env.MICROSOFT_SECRET;
  const missing=await app.inject({url:'/mojang/verify',headers:{'x-test-user':String(ids[2])}});
  check(missing.statusCode===503&&missing.json().configurationProblem,'Missing credentials produce explicit unavailable state');
  process.env.MICROSOFT_KEY='test-client';process.env.MICROSOFT_SECRET='test-secret';
  const csrf=await app.inject({method:'POST',url:'/mojang/verify',headers:{'x-test-user':String(ids[2])},payload:{csrf:'wrong'}});
  check(csrf.statusCode===403,'Start POST requires CSRF');
  const start=await app.inject({method:'POST',url:'/mojang/verify',headers:{'x-test-user':String(ids[2])},payload:{csrf:'csrf-test'}});
  check(start.statusCode===302,'Configured start produces Microsoft redirect');
  const state=new URL(start.headers.location!).searchParams.get('state')!;
  const cross=await app.inject({url:`/mojang/callback?code=fake&state=${encodeURIComponent(state)}`,headers:{'x-test-user':String(ids[2]),'x-test-sid':'b'.repeat(64)}});
  check(cross.statusCode===400,'Callback rejects another browser session');
  const cancelled=await app.inject({url:`/mojang/callback?error=access_denied&state=${encodeURIComponent(state)}`,headers:{'x-test-user':String(ids[2])}});
  check(cancelled.statusCode===400,'Denied Microsoft consent is handled');
  const replay=await app.inject({url:`/mojang/callback?code=fake&state=${encodeURIComponent(state)}`,headers:{'x-test-user':String(ids[2])}});
  check(replay.statusCode===400,'Microsoft state is single use');
  console.log(`Mojang integration: ${checks} checks passed (upstream HTTP mocked; database isolated)`);
} finally {
  await setOption('plugins_enabled',originalPlugins);await setOption('mojang_verification_score_award',originalReward);await setOption('max_players_per_user',originalLimit);
  if(oldKey===undefined)delete process.env.MICROSOFT_KEY;else process.env.MICROSOFT_KEY=oldKey;
  if(oldSecret===undefined)delete process.env.MICROSOFT_SECRET;else process.env.MICROSOFT_SECRET=oldSecret;
  for(const uid of ids){
    await exec('DELETE FROM mojang_verifications WHERE user_id=?',[uid]);
    await exec("DELETE FROM mcn_oauth_flows WHERE JSON_EXTRACT(payload,'$.linkUid')=?",[uid]);
    await exec('DELETE FROM players WHERE uid=?',[uid]);
    await exec('DELETE FROM textures WHERE uploader=?',[uid]);
    await exec('DELETE FROM users WHERE uid=?',[uid]);
  }
  for(const name of names)await exec('DELETE FROM `uuid` WHERE name=?',[name]);
  await app.close();await pool.end();
}
