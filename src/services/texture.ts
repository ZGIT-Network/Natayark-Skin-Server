import fs from 'node:fs/promises';
import path from 'node:path';
import { query, queryOne, exec, insert, nowString, withTransaction } from '../db.js';
import { config } from '../config.js';
import { getOption, getOptionBool, getOptionInt } from './option.js';
import { sha256Hex } from '../util.js';
import { PNG } from 'pngjs';

export type Texture = {
  tid: number;
  name: string;
  type: 'steve' | 'alex' | 'cape';
  hash: string;
  size: number; // KiB (as stored by BS)
  uploader: number;
  public: number;
  upload_at: string;
  likes: number;
};

export function texturePath(hash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid texture hash');
  return path.join(config.textureDir, hash);
}

export async function textureExists(hash: string): Promise<boolean> {
  try {
    const stat = await fs.stat(texturePath(hash));
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function saveTextureFile(hash: string, data: Buffer): Promise<void> {
  if (await textureExists(hash)) return;
  await fs.mkdir(config.textureDir, { recursive: true });
  // Content-addressed files are immutable, including concurrent uploads.
  await fs.writeFile(texturePath(hash), data, { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

export async function readTextureFile(hash: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(texturePath(hash));
  } catch {
    return null;
  }
}

export async function findTextureByTid(tid: number): Promise<Texture | null> {
  return queryOne<Texture>('SELECT * FROM textures WHERE tid = ?', [tid]);
}

export async function findTextureByHashAndUploader(hash: string, uploader: number): Promise<Texture | null> {
  return queryOne<Texture>('SELECT * FROM textures WHERE hash = ? AND uploader = ?', [hash, uploader]);
}

export type TextureMeta = {
  name: string;
  type: 'steve' | 'alex' | 'cape';
  isPublic: boolean;
};

export type UploadResult =
  | { ok: true; texture: Texture; cost: number; duplicate: boolean }
  | { ok: false; reason: string };

export type TextureEconomy = {
  publicStorage: number;
  privateStorage: number;
  closet: number;
  uploadAward: number;
  likeAward: number;
  returnScore: boolean;
  takeBack: boolean;
};

/** Arithmetic follows SkinlibController and UpdateScoreForDeletedTexture exactly. */
export function uploadCost(size: number, isPublic: boolean, rules: TextureEconomy): number {
  return size * (isPublic ? rules.publicStorage : rules.privateStorage) + rules.closet - rules.uploadAward;
}

export function deletionScoreDelta(texture: Pick<Texture, 'size' | 'public'>, rules: TextureEconomy): number {
  return (rules.returnScore ? texture.size * (texture.public ? rules.publicStorage : rules.privateStorage) : 0)
    - (texture.public && rules.takeBack ? rules.uploadAward : 0);
}

export function privacyScoreDelta(texture: Pick<Texture, 'size' | 'public'>, rules: TextureEconomy): number {
  return texture.size * (rules.privateStorage - rules.publicStorage) * (texture.public ? -1 : 1)
    - (texture.public && rules.takeBack ? rules.uploadAward : 0);
}

async function economy(): Promise<TextureEconomy> {
  const [publicStorage, privateStorage, closet, uploadAward, likeAward, returnScore, takeBack] = await Promise.all([
    getOptionInt('score_per_storage', 3), getOptionInt('private_score_per_storage', 25),
    getOptionInt('score_per_closet_item', 2), getOptionInt('score_award_per_texture', 0),
    getOptionInt('score_award_per_like', 0), getOptionBool('return_score', false),
    getOptionBool('take_back_scores_after_deletion', true),
  ]);
  return { publicStorage, privateStorage, closet, uploadAward, likeAward, returnScore, takeBack };
}

async function lockUsers(uids: number[]): Promise<void> {
  const ids = [...new Set(uids)].filter((uid) => uid > 0).sort((a, b) => a - b);
  if (ids.length) await query(`SELECT uid FROM users WHERE uid IN (${ids.map(() => '?').join(',')}) ORDER BY uid FOR UPDATE`, ids);
}

/** The old site rejects a duplicate; it never implicitly purchases a closet item. */
export async function uploadTexture(
  uploader: UserLike,
  meta: TextureMeta,
  file: { data: Buffer; name: string },
  options: { source?: 'web' | 'yggdrasil' } = {}
): Promise<UploadResult> {
  const maxFileSize = await getOptionInt('max_upload_file_size', 1024);
  if (file.data.length > maxFileSize * 1024) return { ok: false, reason: 'file-too-large' };
  if (!(await textureNameValid(meta.name))) return { ok: false, reason: 'invalid-name' };

  const validation = await validateTexturePng(file.data, meta.type, meta.type === 'alex');
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const isAlex = meta.type === 'alex';
  const type: Texture['type'] = meta.type === 'cape' ? 'cape' : isAlex ? 'alex' : 'steve';

  const hash = sha256Hex(file.data);
  const kbSize = Math.ceil(file.data.length / 1024);
  const rules = await economy();
  const isYggdrasil = options.source === 'yggdrasil';
  // ProfileController deliberately grants no upload award on Yggdrasil uploads.
  const cost = isYggdrasil ? kbSize * rules.privateStorage + rules.closet : uploadCost(kbSize, meta.isPublic, rules);
  return withTransaction<UploadResult>(async () => {
    // A locking range read also serializes same-hash insertions in InnoDB.
    const duplicate = await queryOne<Texture>(
      `SELECT * FROM textures WHERE hash = ? AND ${isYggdrasil ? 'uploader = ?' : '(public = 1 OR uploader = ?)'} ORDER BY tid LIMIT 1 FOR UPDATE`,
      [hash, uploader.uid]
    );
    if (duplicate) return { ok: true, texture: duplicate, cost: 0, duplicate: true };
    await lockUsers([uploader.uid]);
    const user = await queryOne<{ score: number; permission: number }>('SELECT score, permission FROM users WHERE uid = ?', [uploader.uid]);
    if (!user || user.permission < 0) return { ok: false, reason: 'forbidden' };
    if (cost > user.score) return { ok: false, reason: 'lack_score' };
    // Save first: a filesystem failure must not commit a record with a missing image.
    await saveTextureFile(hash, file.data);
    const tid = await insert(
      'INSERT INTO textures (name, type, hash, size, uploader, public, upload_at, likes) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [meta.name, type, hash, kbSize, uploader.uid, meta.isPublic ? 1 : 0, nowString()]
    );
    await exec('INSERT INTO user_closet (user_uid, texture_tid, item_name) VALUES (?, ?, ?)', [uploader.uid, tid, meta.name]);
    await exec('UPDATE users SET score = score - ? WHERE uid = ?', [cost, uploader.uid]);
    return { ok: true, texture: (await findTextureByTid(tid))!, cost, duplicate: false };
  });
}

export type PngValidation = { ok: true } | { ok: false; reason: string };

/** Size rules copied from BS: skins 1:1 or 2:1 (w%64==0, h%32==0); capes exactly 2:1. */
export async function validateTexturePng(data: Buffer, type: 'steve' | 'alex' | 'cape', slim?: boolean): Promise<PngValidation> {
  // Inspect IHDR before decoding to bound decompression and allocation.
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ok: false, reason: 'invalid-image' };
  const declaredWidth = data.readUInt32BE(16);
  const declaredHeight = data.readUInt32BE(20);
  if (!declaredWidth || !declaredHeight || declaredWidth > 4096 || declaredHeight > 4096 || declaredWidth * declaredHeight > 8_388_608) return { ok: false, reason: 'image-too-large' };
  let png: PNG;
  try {
    png = PNG.sync.read(data);
  } catch {
    return { ok: false, reason: 'invalid-image' };
  }
  const { width, height } = png;
  if (width === 0 || height === 0) return { ok: false, reason: 'invalid-image' };
  if (width % 64 !== 0 || height % 32 !== 0) return { ok: false, reason: 'invalid-hd-skin' };
  const ratio = width / height;
  if (type === 'cape') {
    if (ratio !== 2) return { ok: false, reason: 'invalid-cape-size' };
  } else {
    if (ratio !== 2 && ratio !== 1) return { ok: false, reason: 'invalid-skin-size' };
    if (slim && ratio === 2) return { ok: false, reason: 'invalid-slim-size' };
  }
  return { ok: true };
}

export async function deleteTexture(texture: Texture): Promise<void> {
  const rules = await economy();
  await withTransaction(async () => {
    await lockUsers([texture.uploader]);
    const current = await queryOne<Texture>('SELECT * FROM textures WHERE tid = ? FOR UPDATE', [texture.tid]);
    if (!current) return; // repeated DELETE must not refund twice
    const delta = deletionScoreDelta(current, rules);
    if (delta) await exec('UPDATE users SET score = score + ? WHERE uid = ?', [delta, current.uploader]);
    // Core CleanUpCloset refunds other users, while the uploader's storage refund
    // is handled above. Reports are retained for the review/audit history.
    if (rules.returnScore && rules.closet) {
      await exec('UPDATE users u JOIN user_closet c ON c.user_uid = u.uid SET u.score = u.score + ? WHERE c.texture_tid = ? AND c.user_uid <> ?', [rules.closet, current.tid, current.uploader]);
    }
    await exec('DELETE FROM user_closet WHERE texture_tid = ?', [current.tid]);
    await exec('DELETE FROM textures_description WHERE tid = ?', [current.tid]);
    await exec('UPDATE players SET tid_skin = 0, last_modified = ? WHERE tid_skin = ?', [nowString(), current.tid]);
    await exec('UPDATE players SET tid_cape = 0, last_modified = ? WHERE tid_cape = ?', [nowString(), current.tid]);
    await exec('DELETE FROM textures WHERE tid = ?', [current.tid]);
  });
  // Unreferenced immutable files are retained until a separate garbage-collection
  // pass. Deleting here is unsafe when an outer report transaction rolls back,
  // or another upload concurrently starts referencing the same content hash.
}

export type PrivacyResult = { ok: true } | { ok: false; reason: 'not_found' | 'lack_score' | 'duplicate'; duplicateTid?: number };

export async function setTexturePrivacy(texture: Texture, isPublic: boolean): Promise<PrivacyResult> {
  const rules = await economy();
  return withTransaction<PrivacyResult>(async () => {
    await lockUsers([texture.uploader]);
    const current = await queryOne<Texture>('SELECT * FROM textures WHERE tid = ? FOR UPDATE', [texture.tid]);
    if (!current) return { ok: false, reason: 'not_found' };
    if (!!current.public === isPublic) return { ok: true };
    if (isPublic) {
      const dup = await queryOne<{ tid: number }>('SELECT tid FROM textures WHERE hash = ? AND public = 1 AND tid <> ? LIMIT 1 FOR UPDATE', [current.hash, current.tid]);
      if (dup) return { ok: false, reason: 'duplicate', duplicateTid: dup.tid };
    }
    const delta = privacyScoreDelta(current, rules);
    const user = await queryOne<{ score: number }>('SELECT score FROM users WHERE uid = ?', [current.uploader]);
    if (!user || user.score + delta < 0) return { ok: false, reason: 'lack_score' };
    await exec('UPDATE users SET score = score + ? WHERE uid = ?', [delta, current.uploader]);
    await exec('UPDATE textures SET public = ? WHERE tid = ?', [isPublic ? 1 : 0, current.tid]);
    if (!isPublic) {
      if (rules.returnScore && rules.closet) {
        await exec('UPDATE users u JOIN user_closet c ON c.user_uid = u.uid SET u.score = u.score + ? WHERE c.texture_tid = ? AND c.user_uid <> ?', [rules.closet, current.tid, current.uploader]);
      }
      await exec('DELETE FROM user_closet WHERE texture_tid = ? AND user_uid <> ?', [current.tid, current.uploader]);
      await exec('UPDATE players SET tid_skin = 0, last_modified = ? WHERE tid_skin = ? AND uid <> ?', [nowString(), current.tid, current.uploader]);
      await exec('UPDATE players SET tid_cape = 0, last_modified = ? WHERE tid_cape = ? AND uid <> ?', [nowString(), current.tid, current.uploader]);
      const likes = (await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM user_closet WHERE texture_tid = ?', [current.tid]))?.c ?? 0;
      await exec('UPDATE textures SET likes = ? WHERE tid = ?', [likes, current.tid]);
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Closet

export async function closetOf(uid: number): Promise<Array<{ tid: number; name: string; item_name: string; type: string; hash: string; public: number }>> {
  return query(
    `SELECT t.tid, t.name, c.item_name, t.type, t.hash, t.public
     FROM user_closet c JOIN textures t ON t.tid = c.texture_tid
     WHERE c.user_uid = ? ORDER BY c.texture_tid DESC`,
    [uid]
  );
}

export async function closetAdd(uid: number, tid: number, itemName: string): Promise<{ ok: boolean; reason?: 'not_found' | 'dup' | 'lack_score' }> {
  const texture = await findTextureByTid(tid);
  if (!texture) return { ok: false, reason: 'not_found' };
  const rules = await economy();
  return withTransaction(async () => {
    await lockUsers([uid, texture.uploader]);
    const user = await queryOne<{ score: number; permission: number }>('SELECT score, permission FROM users WHERE uid = ?', [uid]);
    const current = await queryOne<Texture>('SELECT * FROM textures WHERE tid = ? FOR UPDATE', [tid]);
    if (!user || user.permission < 0 || !current || (!current.public && current.uploader !== uid && user.permission < 1)) return { ok: false, reason: 'not_found' as const };
    if (await closetHas(uid, tid)) return { ok: false, reason: 'dup' as const };
    if (user.score < rules.closet) return { ok: false, reason: 'lack_score' as const };
    await exec('INSERT INTO user_closet (user_uid, texture_tid, item_name) VALUES (?, ?, ?)', [uid, tid, (itemName || current.name).slice(0, 50)]);
    await exec('UPDATE users SET score = score - ? WHERE uid = ?', [rules.closet, uid]);
    await exec('UPDATE textures SET likes = likes + 1 WHERE tid = ?', [tid]);
    if (current.uploader !== uid && rules.likeAward) await exec('UPDATE users SET score = score + ? WHERE uid = ?', [rules.likeAward, current.uploader]);
    return { ok: true };
  });
}

export async function closetRemove(uid: number, tid: number): Promise<void> {
  const texture = await findTextureByTid(tid);
  const rules = await economy();
  await withTransaction(async () => {
    await lockUsers([uid, texture?.uploader ?? 0]);
    const current = await queryOne<Texture>('SELECT * FROM textures WHERE tid = ? FOR UPDATE', [tid]);
    const result = await exec('DELETE FROM user_closet WHERE user_uid = ? AND texture_tid = ?', [uid, tid]);
    if (!result.affectedRows) return;
    if (rules.returnScore && rules.closet) await exec('UPDATE users SET score = score + ? WHERE uid = ?', [rules.closet, uid]);
    if (current) {
      await exec('UPDATE textures SET likes = GREATEST(0, likes - 1) WHERE tid = ?', [tid]);
      // Matches the old remove handler, including removal of one's own upload.
      if (rules.likeAward) await exec('UPDATE users SET score = score - ? WHERE uid = ?', [rules.likeAward, current.uploader]);
    }
    await exec('UPDATE players SET tid_skin = 0, last_modified = ? WHERE uid = ? AND tid_skin = ?', [nowString(), uid, tid]);
    await exec('UPDATE players SET tid_cape = 0, last_modified = ? WHERE uid = ? AND tid_cape = ?', [nowString(), uid, tid]);
  });
}

export async function closetRename(uid: number, tid: number, itemName: string): Promise<void> {
  await exec('UPDATE user_closet SET item_name = ? WHERE user_uid = ? AND texture_tid = ?', [itemName, uid, tid]);
}

export async function closetHas(uid: number, tid: number): Promise<boolean> {
  const row = await queryOne('SELECT 1 FROM user_closet WHERE user_uid = ? AND texture_tid = ? LIMIT 1', [uid, tid]);
  return !!row;
}

export type UserLike = { uid: number; score: number };

export async function getUserLike(uid: number): Promise<UserLike | null> {
  const row = await queryOne<{ uid: number; score: number }>('SELECT uid, score FROM users WHERE uid = ?', [uid]);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Skin library listing

export type SkinlibFilter = {
  keyword?: string;
  type?: 'steve' | 'alex' | 'cape' | 'skin';
  uploader?: number;
  status?: 'public' | 'private' | 'all';
  sort?: 'time' | 'likes' | 'tid';
  page: number;
  perPage: number;
  viewer?: { uid: number; admin: boolean } | null;
};

export async function skinlibSearch(filter: SkinlibFilter): Promise<{ total: number; items: Array<Texture & { nickname?: string }> }> {
  const conditions: string[] = [];
  const params: any[] = [];

  const viewer = filter.viewer;
  if (!viewer) {
    conditions.push('t.public = 1');
  } else if (!viewer.admin) {
    conditions.push('(t.public = 1 OR t.uploader = ?)');
    params.push(viewer.uid);
  }

  if (filter.keyword) {
    conditions.push('t.name LIKE ?');
    params.push(`%${filter.keyword}%`);
  }
  if (filter.type === 'cape') {
    conditions.push("t.type = 'cape'");
  } else if (filter.type === 'skin') {
    conditions.push("t.type IN ('steve', 'alex')");
  } else if (filter.type) {
    conditions.push('t.type = ?');
    params.push(filter.type);
  }
  if (filter.uploader) {
    conditions.push('t.uploader = ?');
    params.push(filter.uploader);
  }
  if (filter.status === 'public') conditions.push('t.public = 1');
  if (filter.status === 'private') conditions.push('t.public = 0');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = filter.sort === 'likes' ? 't.likes DESC, t.tid DESC' : filter.sort === 'tid' ? 't.tid DESC' : 't.upload_at DESC, t.tid DESC';
  const totalRow = await queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM textures t ${where}`, params);
  const items = await query<Texture & { nickname?: string }>(
    `SELECT t.*, u.nickname FROM textures t LEFT JOIN users u ON u.uid = t.uploader ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, filter.perPage, (filter.page - 1) * filter.perPage]
  );
  return { total: totalRow?.c ?? 0, items };
}

/** Texture description (from textures_description table, used by texture-description plugin). */
export async function getDescription(tid: number): Promise<string> {
  const row = await queryOne<{ description: string }>('SELECT description FROM textures_description WHERE tid = ?', [tid]);
  return row?.description ?? '';
}

export async function setDescription(tid: number, description: string): Promise<void> {
  await withTransaction(async () => {
    if (!(await queryOne('SELECT tid FROM textures WHERE tid = ? FOR UPDATE', [tid]))) return;
    const row = await queryOne('SELECT id FROM textures_description WHERE tid = ? LIMIT 1', [tid]);
    if (row) await exec('UPDATE textures_description SET description = ? WHERE tid = ?', [description, tid]);
    else await exec('INSERT INTO textures_description (tid, description) VALUES (?, ?)', [tid, description]);
  });
}

export async function countTextures(): Promise<number> {
  const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM textures');
  return row?.c ?? 0;
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  return row?.c ?? 0;
}

export async function textureNameValid(name: string): Promise<boolean> {
  if (!name.trim() || [...name].length > 50) return false;
  const regexpStr = await getOption('texture_name_regexp', '');
  if (!regexpStr) return true;
  try {
    const phpPattern = /^([^\w\s\\])([\s\S]*)\1([imsu]*)$/.exec(regexpStr);
    return new RegExp(phpPattern ? phpPattern[2] : regexpStr, phpPattern ? phpPattern[3] : 'u').test(name);
  } catch {
    return false;
  }
}
