import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import {fixtureSchema} from './fixture-schema.js';

const prefix = `test_addon_${crypto.randomBytes(4).toString('hex')}_`;
process.env.DB_TABLE_PREFIX = prefix;
const { config } = await import('../src/config.js');
assert.equal(config.db.tablePrefix, prefix);
const { exec, insert, queryOne, pool, nowString, withTransaction } = await import('../src/db.js');
const { setOption } = await import('../src/services/option.js');
const { registerUser } = await import('../src/services/user.js');
const { createRegistrationLink, registrationLinks, removeRegistrationLink, awardRegistrationShare } = await import('../src/services/sharing.js');
const { createTranslationLine, updateTranslationLine, deleteTranslationLine, translationLines, loadTranslationOverrides, translated } = await import('../src/services/translations.js');
const { registerSharingRoutes } = await import('../src/routes/sharing.js');
const { registerTranslationRoutes } = await import('../src/routes/translations.js');
const tables = ['options', 'users', 'reg_link', 'language_lines'];
const created: string[] = [];
let checks = 0;
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
const score = async (uid: number) => (await queryOne<{ score: number }>('SELECT score FROM users WHERE uid = ?', [uid]))!.score;
const user = (permission = 0) => insert('INSERT INTO users (email,nickname,score,password,permission,ip,last_sign_at,register_at,verified,verification_token) VALUES (?,?,100,?,?,?, ?,?,1,?)', [`addon-${crypto.randomBytes(6).toString('hex')}@example.invalid`, 'fixture', '', permission, '127.0.0.1', nowString(-86400), nowString(), '']);
const app = Fastify();
await app.register(formbody);
app.decorateReply('view', function (_name: string, data: object) { return this.send(data); });
app.addHook('onRequest', async (request: any) => {
  request.currentUser = request.headers['x-test-uid'] ? await queryOne('SELECT * FROM users WHERE uid = ?', [Number(request.headers['x-test-uid'])]) : null;
  request.csrfToken = () => 'fixture';
  request.checkCsrf = (value: unknown) => value === 'fixture';
});
try {
  for (const table of tables) { await exec(fixtureSchema(table)); created.push(table); }
  await exec(`CREATE TABLE \`${prefix}mcn_registration_rewards\` (uid INT UNSIGNED PRIMARY KEY,code_id INT UNSIGNED NOT NULL,sharer INT NOT NULL,created_at DATETIME NOT NULL) ENGINE=InnoDB`);
  created.push('mcn_registration_rewards');
  for (const [key, value] of Object.entries({ plugins_enabled: JSON.stringify({ 'share-registration-link': { version: 'fixture' } }), reg_link_sharer_score: '50', reg_link_sharee_score: '10', user_initial_score: '100', register_with_player_name: '0', require_verification: '0' })) await setOption(key, value);
  const inviter = await user(), other = await user(), admin = await user(1);
  const code = await createRegistrationLink(inviter);
  check(/^[A-Za-z0-9]{20}$/.test(code.code) && code.url.endsWith(`?share=${code.code}`), 'share code preserves original 20-character shape and registration URL');
  check((await registrationLinks(inviter)).records.length === 1 && !(await removeRegistrationLink(other, code.id)), 'links list and deletion enforce owner isolation');
  check(!(await awardRegistrationShare(other, 'unknown')).awarded && await score(other) === 100, 'unknown optional referral is ignored');
  const registration = await registerUser({ email: `referral-${crypto.randomBytes(6).toString('hex')}@example.invalid`, nickname: 'referral', password: 'fixture-password', share: code.code, verified: true });
  check(registration.ok, 'registration accepts original optional share field');
  if (!registration.ok) throw new Error('Registration fixture failed');
  check(await score(inviter) === 150 && await score(registration.user.uid) === 110, 'new registration rewards inviter and recipient within its transaction');
  const attempts = await Promise.all(Array.from({ length: 10 }, () => awardRegistrationShare(registration.user.uid, code.code)));
  check(attempts.every((r) => !r.awarded) && await score(inviter) === 150, 'referral callback replay cannot award a second time');
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => awardRegistrationShare(other, code.code)));
  check(concurrent.filter((r) => r.awarded).length === 1 && await score(inviter) === 200 && await score(other) === 110, 'concurrent referral reward calls settle exactly once');
  const rollbackUser = await user();
  await assert.rejects(withTransaction(async () => { await awardRegistrationShare(rollbackUser, code.code); throw new Error('rollback-referral'); }), /rollback-referral/);
  check(await score(inviter) === 200 && await score(rollbackUser) === 100 && !(await queryOne('SELECT uid FROM mcn_registration_rewards WHERE uid = ?', [rollbackUser])), 'referral reward and ledger roll back with outer registration transaction');

  await registerSharingRoutes(app);
  await registerTranslationRoutes(app);
  await app.ready();
  check((await app.inject('/user/reg-links')).statusCode === 401, 'anonymous user cannot list referral links');
  check((await app.inject({ method: 'POST', url: '/user/reg-links', headers: { 'x-test-uid': String(inviter) }, payload: {} })).statusCode === 403, 'share creation rejects missing CSRF');
  const listed = await app.inject({ url: '/user/reg-links', headers: { 'x-test-uid': String(inviter) } });
  check(listed.statusCode === 200 && listed.json().records[0].id === code.id && listed.json().sharer === 50, 'legacy links JSON returns records and configured rewards');
  check((await app.inject({ method: 'DELETE', url: `/user/reg-links/${code.id}`, headers: { 'x-test-uid': String(other) }, payload: { csrf: 'fixture' } })).statusCode === 404, 'legacy delete cannot remove another user link');

  const line = await createTranslationLine('common', 'save', 'zh_CN', '测试保存');
  await updateTranslationLine(line, 'en', 'Fixture save');
  await loadTranslationOverrides(true);
  check(translated('zh_CN', 'common.save') === '测试保存' && translated('en', 'common.save') === 'Fixture save', 'database overrides apply in both UI languages');
  check((await translationLines()).data[0].text.zh_CN === '测试保存', 'updating another language preserves existing translation');
  check((await app.inject({ url: '/admin/i18n/list', headers: { 'x-test-uid': String(other) } })).statusCode === 403, 'normal user cannot read translation management');
  check((await app.inject({ method: 'PUT', url: `/admin/i18n/${line}`, headers: { 'x-test-uid': String(admin) }, payload: { text: 'Updated' } })).statusCode === 403, 'translation changes require CSRF');
  const changed = await app.inject({ method: 'PUT', url: `/admin/i18n/${line}`, headers: { 'x-test-uid': String(admin) }, payload: { csrf: 'fixture', locale: 'en', text: 'Updated' } });
  await loadTranslationOverrides();
  check(changed.statusCode === 200 && translated('en', 'common.save') === 'Updated', 'legacy translation update invalidates override cache');
  await deleteTranslationLine(line);
  await loadTranslationOverrides();
  check(translated('en', 'common.save') !== 'Updated', 'deleting a translation restores built-in fallback');
  check(await removeRegistrationLink(inviter, code.id) && !(await awardRegistrationShare(await user(), code.code)).awarded, 'deleted referral code cannot award new registrations');
  console.log(`Addon integration: ${checks} checks passed on schema-only ${prefix} tables.`);
} finally {
  await app.close();
  for (const table of created.reverse()) await exec(`DROP TABLE \`${prefix}${table}\``).catch((error) => console.error(`Failed to drop ${prefix}${table}: ${error.message}`));
  await pool.end();
}
