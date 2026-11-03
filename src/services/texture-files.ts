import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT_DIR } from '../config.js';
import { afterTransaction, queryOne, withTransaction } from '../db.js';

/** Writers and GC share a connection-scoped MySQL mutex until transaction end. */
export async function lockTextureFile(hash: string): Promise<void> {
  const key = 'texture:' + crypto.createHash('sha256').update(config.textureDir + ':' + hash).digest('hex').slice(0, 56);
  const row = await queryOne<{ acquired: number }>('SELECT GET_LOCK(?, 10) AS acquired', [key]);
  if (row?.acquired !== 1) throw Object.assign(new Error('Texture storage is busy'), { statusCode: 503 });
  afterTransaction(async () => { await queryOne('SELECT RELEASE_LOCK(?)', [key]); });
}

export type GarbageCollectionOptions = { apply?: boolean; retentionMs?: number; now?: number; limit?: number };
export async function collectTextureGarbage(options: GarbageCollectionOptions = {}) {
  const retention = options.retentionMs ?? 24 * 3600_000;
  const cutoff = (options.now ?? Date.now()) - retention;
  const result = { scanned: 0, eligible: 0, removed: 0 };
  // An isolated database copy must never collect a shared production directory.
  if (config.db.tablePrefix && config.textureDir === path.join(ROOT_DIR, 'storage', 'textures')) {
    return { ...result, skipped: 'A table namespace requires a dedicated texture directory for GC' };
  }
  let directory;
  try { directory = await fs.opendir(config.textureDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  for await (const entry of directory) {
    if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    result.scanned++;
    const file = path.join(config.textureDir, entry.name);
    try {
      if ((await fs.lstat(file)).mtimeMs > cutoff) continue;
      await withTransaction(async () => {
        await lockTextureFile(entry.name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.mtimeMs > cutoff) return;
        // A locking read sees commits made while waiting for the file mutex.
        if (await queryOne('SELECT tid FROM textures WHERE hash = ? LIMIT 1 FOR UPDATE', [entry.name])) return;
        result.eligible++;
        if (options.apply) { await fs.unlink(file); result.removed++; }
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (result.eligible >= (options.limit ?? 500)) break;
  }
  return result;
}
