import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {fixtureSchema} from './fixture-schema.js';
import { PNG } from 'pngjs';
import Fastify from 'fastify';

// Each invocation gets empty tables from the distributable schema;
// existing accounts, options and images are never used as test fixtures.
const suffix = crypto.randomBytes(4).toString('hex');
const prefix = `test_econ_${suffix}_`;
process.env.DB_TABLE_PREFIX = prefix;
process.env.TEXTURE_DIR = `.test-artifacts/economy-${suffix}`;
const { config } = await import('../src/config.js');
assert.equal(config.db.tablePrefix, prefix);
const { exec, insert, queryOne, pool, nowString, withTransaction } = await import('../src/db.js');
const { setOption } = await import('../src/services/option.js');
const { uploadTexture, closetAdd, closetRemove, setTexturePrivacy, deleteTexture, findTextureByTid, setDescription, getDescription } = await import('../src/services/texture.js');
const { addPlayer, bindSinglePlayer, deletePlayer, setPlayerTexture, findPlayerByPid } = await import('../src/services/player.js');
const { registerTextureRoutes } = await import('../src/routes/textures.js');
const { batchImportTextures } = await import('../src/services/batch-import.js');
const tables = ['options', 'users', 'players', 'uuid', 'textures', 'user_closet', 'textures_description'];
const created: string[] = [];
let imageNumber = 0, checks = 0;
const app = Fastify();
app.decorateReply('view', function (_name: string, model: object) { return this.send(model); });
app.addHook('onRequest', async (request: any) => {
  request.currentUser = request.headers['x-test-uid'] ? await queryOne('SELECT * FROM users WHERE uid = ?', [Number(request.headers['x-test-uid'])]) : null;
  request.csrfToken = () => 'fixture';
});
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
const score = async (uid: number) => (await queryOne<{ score: number }>('SELECT score FROM users WHERE uid = ?', [uid]))!.score;
const user = (value = 100) => insert('INSERT INTO users (email,nickname,score,password,ip,last_sign_at,register_at,verified,verification_token) VALUES (?,?,?,?,?,?,?,1,?)', [`economic-${crypto.randomBytes(6).toString('hex')}@example.invalid`, 'fixture', value, '', '127.0.0.1', nowString(-86400), nowString(), '']);
function image(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  png.data[0] = ++imageNumber;
  png.data[3] = 255;
  return PNG.sync.write(png);
}
async function upload(uid: number, isPublic = true, data = image()) {
  const result = await uploadTexture({ uid, score: -999 }, { name: `fixture-${imageNumber}`, type: 'steve', isPublic }, { data, name: 'fixture' });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

try {
  for (const table of tables) {
    // The fixed fixture schema and namespace are independent of existing tables.
    await exec(fixtureSchema(table));
    created.push(table);
  }
  for (const [key, value] of Object.entries({ score_per_storage: '3', private_score_per_storage: '25', score_per_closet_item: '2', score_award_per_texture: '20', score_award_per_like: '5', return_score: '1', take_back_scores_after_deletion: '1', max_upload_file_size: '1024', plugins_enabled: '{}', score_per_player: '100', ygg_uuid_algorithm: 'v3' })) await setOption(key, value);

  const owner = await user(0);
  const uploaded = await upload(owner);
  check(uploaded.cost === -15 && await score(owner) === 15, 'negative net upload cost is accepted before affordability check');
  check(uploaded.texture.likes === 1, 'uploader initial closet contributes one like');
  const other = await user(100);
  const duplicate = await upload(other, true, await fs.readFile(path.join(config.textureDir, uploaded.texture.hash)));
  check(duplicate.duplicate && duplicate.texture.tid === uploaded.texture.tid && await score(other) === 100, 'public duplicate does not insert, charge or implicitly collect');

  const results = await Promise.all(Array.from({ length: 8 }, () => closetAdd(other, uploaded.texture.tid, 'collected')));
  check(results.filter((r) => r.ok).length === 1 && await score(other) === 98, 'concurrent duplicate closet additions charge only once');
  check((await findTextureByTid(uploaded.texture.tid))!.likes === 2 && await score(owner) === 20, 'collecting updates likes and awards uploader once');
  const pid = await insert('INSERT INTO players (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,?,0,?)', [other, `skin${suffix}`, uploaded.texture.tid, nowString(-86400)]);
  await Promise.all(Array.from({ length: 4 }, () => closetRemove(other, uploaded.texture.tid)));
  check(await score(other) === 100 && await score(owner) === 15, 'concurrent removals refund and withdraw award once');
  check((await findPlayerByPid(pid))!.tid_skin === 0 && (await findPlayerByPid(pid))!.last_modified > nowString(-30), 'removing closet item clears player skin and invalidates client cache');

  const richOwner = await user(100);
  const privateSwitch = await upload(richOwner);
  check((await closetAdd(other, privateSwitch.texture.tid, 'switch')).ok, 'second user collects public texture');
  await setPlayerTexture((await findPlayerByPid(pid))!, 'skin', privateSwitch.texture.tid);
  const privacy = await setTexturePrivacy(privateSwitch.texture, false);
  check(privacy.ok && await score(richOwner) === 78, 'public-to-private applies storage delta and award withdrawal');
  check(await score(other) === 100 && (await findPlayerByPid(pid))!.tid_skin === 0, 'privacy switch removes/refunds other closets and clears their player skin');
  check((await findTextureByTid(privateSwitch.texture.tid))!.likes === 1, 'privacy switch retains uploader like only');
  await Promise.all([deleteTexture(privateSwitch.texture), deleteTexture(privateSwitch.texture)]);
  check(await score(richOwner) === 103, 'repeated delete refunds private storage exactly once');

  const yggOwner = await user(100);
  const ygg = await uploadTexture({ uid: yggOwner, score: 99999 }, { name: 'private-ygg', type: 'steve', isPublic: false }, { data: image(), name: 'private-ygg' }, { source: 'yggdrasil' });
  check(ygg.ok && ygg.cost === 27 && await score(yggOwner) === 73, 'Yggdrasil upload has no web upload reward');

  const poor = await user(2);
  const textures = [await upload(await user()), await upload(await user())];
  const purchases = await Promise.all(textures.map((r) => closetAdd(poor, r.texture.tid, 'one')));
  check(purchases.filter((r) => r.ok).length === 1 && await score(poor) === 0, 'concurrent different purchases cannot spend the same balance twice');

  const rollbackOwner = await user(100);
  let rolledTid = 0;
  await assert.rejects(withTransaction(async () => {
    rolledTid = (await upload(rollbackOwner)).texture.tid;
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  check(await score(rollbackOwner) === 100 && !(await findTextureByTid(rolledTid)), 'outer transaction rollback restores score, upload and closet atomically');

  await setDescription(uploaded.texture.tid, 'first');
  await setDescription(uploaded.texture.tid, 'updated');
  check(await getDescription(uploaded.texture.tid) === 'updated', 'description update does not rely on a tid unique constraint');

  const playerOwner = await user(150);
  const players = await Promise.all([addPlayer(playerOwner, `ecoA${suffix}`), addPlayer(playerOwner, `ecoB${suffix}`)]);
  check(players.filter((p) => p.ok).length === 1 && await score(playerOwner) === 50, 'concurrent players respect latest locked balance');
  const charged = players.find((p) => p.ok)!;
  if (charged.ok) await Promise.all([deletePlayer(charged.player), deletePlayer(charged.player)]);
  check(await score(playerOwner) === 150, 'repeated player deletion refunds once');
  await setOption('max_players_per_user','1');
  const limitedOwner=await user(1000);
  const capped=await Promise.all([addPlayer(limitedOwner,'capA'+suffix),addPlayer(limitedOwner,'capB'+suffix)]);
  check(capped.filter(result=>result.ok).length===1&&await score(limitedOwner)===900,'concurrent player creation enforces the fixed count under the account lock');
  await setOption('max_players_per_user','2');
  check((await addPlayer(limitedOwner,'capC'+suffix)).ok,'raising the configured limit allows the next player');
  await setOption('max_players_per_user','0');
  await setOption('plugins_enabled', JSON.stringify({ 'single-player-limit': { version: 'fixture' } }));
  check(!(await addPlayer(playerOwner, `ecoC${suffix}`)).ok, 'single-player-limit prevents normal additions');
  const binding = await bindSinglePlayer(playerOwner, `ecoD${suffix}`);
  check(binding.ok && await score(playerOwner) === 150, 'initial single-player binding is free');
  if (binding.ok) {
    await assert.rejects(deletePlayer(binding.player), /单角色限制/);
    await deletePlayer(binding.player, { bypassLimit: true });
    check(await score(playerOwner) === 150, 'admin player deletion bypasses restriction without refund');
  }

  await setOption('plugins_enabled', JSON.stringify({ '204-for-unexisted-players': { version: 'fixture' }, gravatar: { version: 'fixture' } }));
  await registerTextureRoutes(app);
  await app.ready();
  const hashUrl = `/textures/${uploaded.texture.hash}`;
  const raw = await app.inject(hashUrl);
  check(raw.statusCode === 200 && raw.headers['content-type'] === 'image/png' && raw.headers.etag === `"${uploaded.texture.hash}"`, 'raw texture has PNG MIME and content-addressed ETag');
  check((await app.inject({ url: hashUrl, headers: { 'if-none-match': raw.headers.etag! } })).statusCode === 304, 'raw conditional GET returns 304');
  check((await app.inject(`/textures/${'f'.repeat(64)}`)).statusCode === 404, 'missing texture file returns 404 without an asynchronous stream error');
  check((await app.inject('/does-not-exist.json')).statusCode === 204, 'enabled compatibility plugin returns 204 for missing CSL player');
  const csl = await app.inject(`/skin${suffix}.json`);
  check(csl.statusCode === 200 && csl.json().skins.default === null && csl.json().cape === null, 'CSL preserves explicit null skin and cape fields');
  await setPlayerTexture((await findPlayerByPid(pid))!, 'skin', uploaded.texture.tid);
  const usm = await app.inject(`/usm/skin${suffix}.json`);
  check(usm.statusCode === 200 && usm.json().skins.default === uploaded.texture.hash && Number.isInteger(usm.json().last_update), 'USM provides skin hash and Unix last_update');
  check((await app.inject(`/skin/skin${suffix}.png`)).statusCode === 200 && (await app.inject(`/cape/skin${suffix}.png`)).statusCode === 404, 'legacy PNG routes resolve the player skin and missing cape');
  check((await app.inject(`/avatar/user/${other}`)).statusCode===200, 'equipped skin takes priority over enabled Gravatar provider');
  await exec('UPDATE players SET tid_skin=0 WHERE pid=?',[pid]);
  check((await app.inject(`/avatar/user/${other}`)).headers.location?.startsWith('https://weavatar.com/avatar/'), 'enabled Gravatar provider is a fallback when no skin is equipped');
  await exec('UPDATE players SET tid_skin=? WHERE pid=?',[uploaded.texture.tid,pid]);
  check((await app.inject('/user/config')).statusCode === 302, 'configuration download requires a logged-in user');
  const downloaded = await app.inject({ url: '/user/config?download=csl', headers: { 'x-test-uid': String(other) } });
  check(downloaded.statusCode === 200 && downloaded.headers['content-disposition'] === 'attachment; filename="CustomSkinLoader.json"' && downloaded.json().loadlist[0].type === 'CustomSkinAPI', 'CSL configuration download preserves site-first ordering and attachment name');

  const importDirectory = path.join(config.textureDir, 'import-fixtures');
  await fs.mkdir(importDirectory);
  const importData = image();
  await fs.writeFile(path.join(importDirectory, '皮肤.png'), importData);
  await fs.writeFile(path.join(importDirectory, 'duplicate.png'), importData);
  await fs.writeFile(path.join(importDirectory, 'invalid.png'), 'not a PNG');
  const beforeImport = await score(other);
  const preview = await batchImportTextures({ uploader: other, directory: importDirectory });
  check(preview.filter((r) => r.status === 'would-import').length === 1 && preview.filter((r) => r.status === 'duplicate').length === 1 && preview.filter((r) => r.status === 'invalid').length === 1, 'batch dry-run validates input and deduplicates identical files');
  const imported = await batchImportTextures({ uploader: other, directory: importDirectory, dryRun: false });
  const entry = imported.find((r) => r.status === 'imported');
  check(entry?.type === 'alex' && !!entry.tid && await score(other) === beforeImport, 'batch apply preserves RGB model detection without changing uploader balance');
  check(!(await queryOne('SELECT 1 FROM user_closet WHERE texture_tid = ?', [entry!.tid])), 'batch import creates no automatic closet item');
  check((await batchImportTextures({ uploader: other, directory: importDirectory, dryRun: false })).filter((r) => r.status === 'imported').length === 0, 'repeated batch import is idempotent');
  console.log(`Economy integration: ${checks} checks passed on schema-only ${prefix} tables.`);
} finally {
  await app.close();
  for (const table of created.reverse()) await exec(`DROP TABLE \`${table}\``).catch((error) => console.error(`Failed to drop test table ${prefix}${table}: ${error.message}`));
  await pool.end();
  const artifactRoot = path.resolve(process.cwd(), '.test-artifacts');
  const target = path.resolve(config.textureDir);
  if (target.startsWith(artifactRoot + path.sep) && path.basename(target) === `economy-${suffix}`) await fs.rm(target, { recursive: true, force: true });
}
