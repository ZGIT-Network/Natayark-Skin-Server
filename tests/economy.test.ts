import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { uploadCost, deletionScoreDelta, privacyScoreDelta, validateTexturePng, texturePath, type TextureEconomy } from '../src/services/texture.js';
import { isAlexTexture } from '../src/services/batch-import.js';

// Expected values were evaluated from the supplied PHP controllers/listeners.
const rules: TextureEconomy = { publicStorage: 3, privateStorage: 25, closet: 2, uploadAward: 20, likeAward: 5, returnScore: true, takeBack: true };

test('approved content reward offsets public and private web upload costs', () => {
  assert.equal(uploadCost(1, true, rules), -15);
  assert.equal(uploadCost(1, false, rules), 7);
  assert.equal(uploadCost(10, true, rules), 12);
  assert.equal(uploadCost(10, false, rules), 232);
});

test('deletion refund and public upload award withdrawal are independent settings', () => {
  const texture = { size: 10, public: 1 };
  assert.equal(deletionScoreDelta(texture, rules), 10);
  assert.equal(deletionScoreDelta(texture, { ...rules, returnScore: false }), -20);
  assert.equal(deletionScoreDelta(texture, { ...rules, takeBack: false }), 30);
  assert.equal(deletionScoreDelta(texture, { ...rules, returnScore: false, takeBack: false }), 0);
  assert.equal(deletionScoreDelta({ size: 10, public: 0 }, rules), 230);
  assert.equal(deletionScoreDelta({ size: 10, public: 0 }, { ...rules, uploadAward: 0 }), 250);
});

test('privacy switches match the supplied site economy, including award withdrawal', () => {
  assert.equal(privacyScoreDelta({ size: 10, public: 1 }, rules), -240);
  assert.equal(privacyScoreDelta({ size: 10, public: 0 }, rules), 220);
  assert.equal(privacyScoreDelta({ size: 10, public: 1 }, { ...rules, takeBack: false }), -220);
});

function image(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

test('skin/cape validation rejects malformed or incompatible dimensions before allocation', async () => {
  assert.deepEqual(await validateTexturePng(image(64, 64), 'alex', true), { ok: true });
  assert.deepEqual(await validateTexturePng(image(64, 32), 'steve'), { ok: true });
  assert.equal((await validateTexturePng(image(64, 32), 'alex', true)).ok, false);
  assert.deepEqual(await validateTexturePng(image(64, 32), 'cape'), { ok: true });
  assert.equal((await validateTexturePng(image(32, 16), 'cape')).ok, false);
  assert.equal((await validateTexturePng(Buffer.from('not a png'), 'steve')).ok, false);
  const bomb = image(64, 64);
  bomb.writeUInt32BE(1_000_000, 16);
  assert.deepEqual(await validateTexturePng(bomb, 'steve'), { ok: false, reason: 'image-too-large' });
});

test('content-addressed texture paths reject traversal and non-hash filenames', () => {
  assert.throws(() => texturePath('../../private'), /Invalid texture hash/);
  assert.throws(() => texturePath('a'.repeat(63)), /Invalid texture hash/);
  assert.ok(texturePath('a'.repeat(64)).endsWith('a'.repeat(64)));
});

test('batch-import model detection matches the supplied PHP RGB region rule', () => {
  const png = new PNG({ width: 64, height: 64 });
  assert.equal(isAlexTexture(png), true);
  png.data[(52 * 64 + 46) * 4] = 1;
  assert.equal(isAlexTexture(png), false);
  assert.equal(isAlexTexture(new PNG({ width: 64, height: 32 })), false);
});
