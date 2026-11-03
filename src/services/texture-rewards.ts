import crypto from 'node:crypto';
import { parsePng } from './png.js';
import { exec, insert, query, queryOne, nowString } from '../db.js';
import { getOptionInt } from './option.js';
import { readTextureFile, validateTexturePng, type Texture } from './texture.js';

/** Metadata, PNG compression and bytes after IEND do not change this identity. */
export function textureFingerprint(data: Buffer): string {
  const png = parsePng(data);
  // Invisible RGB channels have no visual content and cannot earn another reward.
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset + 3] === 0) png.data.fill(0, offset, offset + 3);
  }
  return crypto.createHash('sha256').update(`${png.width}x${png.height}:rgba:`).update(png.data).digest('hex');
}

/** Called under the uploader lock. Existing files are seeded without changing balances. */
export async function seedLegacyTextureRewards(uid: number, legacyAward: number): Promise<void> {
  const rows = await query<Texture>('SELECT t.* FROM textures t LEFT JOIN mcn_texture_uploads r ON r.texture_id=t.tid WHERE t.uploader=? AND r.texture_id IS NULL ORDER BY t.tid', [uid]);
  for (const texture of rows) {
    const data = await readTextureFile(texture.hash);
    if (!data || !(await validateTexturePng(data, texture.type)).ok) continue;
    const fingerprint = textureFingerprint(data);
    await exec('INSERT IGNORE INTO mcn_texture_rewards (user_id,fingerprint,amount,claimed_at) VALUES (?,?,0,?)', [uid, fingerprint, texture.upload_at]);
    await insert('INSERT IGNORE INTO mcn_texture_uploads (texture_id,fingerprint,reward_remaining) VALUES (?,?,?)', [texture.tid, fingerprint, texture.public ? Math.max(0, legacyAward) : 0]);
  }
}

export async function eligibleTextureReward(uid: number, fingerprint: string, award: number): Promise<number> {
  if (award <= 0 || await queryOne('SELECT 1 FROM mcn_texture_rewards WHERE user_id=? AND fingerprint=?', [uid, fingerprint])) return 0;
  const limit = Math.max(0, await getOptionInt('upload_reward_daily_limit', 10));
  const day = nowString().slice(0, 10);
  const next = new Date(Date.parse(day + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);
  const count = await queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM mcn_texture_rewards WHERE user_id=? AND amount>0 AND claimed_at>=? AND claimed_at<?', [uid, day + ' 00:00:00', next + ' 00:00:00']);
  return Number(count?.count ?? 0) < limit ? award : 0;
}

export async function recordTextureReward(tid: number, uid: number, fingerprint: string, award: number): Promise<void> {
  if (award > 0) await exec('INSERT INTO mcn_texture_rewards (user_id,fingerprint,amount,claimed_at) VALUES (?,?,?,?)', [uid, fingerprint, award, nowString()]);
  await exec('INSERT INTO mcn_texture_uploads (texture_id,fingerprint,reward_remaining) VALUES (?,?,?)', [tid, fingerprint, award]);
}

export async function outstandingTextureReward(tid: number, legacyAward: number): Promise<number> {
  const row = await queryOne<{ reward_remaining: number }>('SELECT reward_remaining FROM mcn_texture_uploads WHERE texture_id=?', [tid]);
  return row ? row.reward_remaining : legacyAward;
}
