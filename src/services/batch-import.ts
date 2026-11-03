import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { parsePng } from './png.js';
import { queryOne, insert, nowString, withTransaction } from '../db.js';
import { saveTextureFile, validateTexturePng, type Texture } from './texture.js';
import { sha256Hex } from '../util.js';
import { lockTextureFile } from './texture-files.js';
import { recordTextureReward, textureFingerprint } from './texture-rewards.js';

export type BatchImportItem = { file: string; status: 'imported' | 'would-import' | 'duplicate' | 'invalid'; tid?: number; reason?: string; type?: Texture['type'] };
export type BatchImportOptions = { uploader: number; directory: string; cape?: boolean; gbk?: boolean; dryRun?: boolean };

/** Matches Blessing\Renderer\TextureUtil::isAlex, including its RGB rule. */
export function isAlexTexture(png: PNG): boolean {
  if (png.width !== png.height) return false;
  const scale = png.width / 64;
  for (let x = 46 * scale; x < 48 * scale; x++) for (let y = 52 * scale; y < 64 * scale; y++) {
    const pixel = (y * png.width + x) * 4;
    if (png.data[pixel] !== 0 || png.data[pixel + 1] !== 0 || png.data[pixel + 2] !== 0) return false;
  }
  return true;
}

/** CLI parity: no score changes, no automatic closet insertion, public uploads. */
export async function batchImportTextures(options: BatchImportOptions): Promise<BatchImportItem[]> {
  if (!Number.isSafeInteger(options.uploader) || options.uploader <= 0 || !(await queryOne('SELECT uid FROM users WHERE uid = ?', [options.uploader]))) throw new Error('Uploader UID does not exist');
  const directory = path.resolve(options.directory);
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error('Import path must be a directory');
  const entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'buffer' });
  const seen = new Set<string>();
  const results: BatchImportItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toString('utf8').toLowerCase().endsWith('.png')) continue;
    const rawName = entry.name.subarray(0, -4);
    // Windows exposes Unicode filenames; GBK decoding is only needed for raw
    // legacy byte filenames on Unix, where the original --gbk option was useful.
    const result: BatchImportItem = { file: rawName.toString('utf8') + '.png', status: 'invalid' };
    results.push(result);
    try {
      const name = options.gbk && process.platform !== 'win32' ? new TextDecoder('gbk', { fatal: true }).decode(rawName) : rawName.toString('utf8');
      result.file = name + '.png';
      if (!name || [...name].length > 50) throw new Error('Texture name must contain 1-50 characters');
      const filePath = Buffer.concat([Buffer.from(directory + path.sep), entry.name]);
      if ((await fs.stat(filePath)).size > 64 * 1024 * 1024) throw new Error('Image file exceeds 64 MiB');
      const data = await fs.readFile(filePath);
      const validation = await validateTexturePng(data, options.cape ? 'cape' : 'steve');
      if (!validation.ok) throw new Error(validation.reason);
      const hash = sha256Hex(data);
      if (seen.has(hash)) { result.status = 'duplicate'; continue; }
      seen.add(hash);
      const type: Texture['type'] = options.cape ? 'cape' : isAlexTexture(parsePng(data)) ? 'alex' : 'steve';
      result.type = type;
      await withTransaction(async () => {
        await lockTextureFile(hash);
        const existing = await queryOne<{ tid: number }>('SELECT tid FROM textures WHERE hash = ? LIMIT 1 FOR UPDATE', [hash]);
        if (existing) { result.status = 'duplicate'; result.tid = existing.tid; return; }
        if (options.dryRun !== false) { result.status = 'would-import'; return; }
        await saveTextureFile(hash, data);
        result.tid = await insert('INSERT INTO textures (name,type,size,hash,uploader,public,upload_at,likes) VALUES (?,?,?,?,?,1,?,0)', [name, type, Math.ceil(data.length / 1024), hash, options.uploader, nowString()]);
        await recordTextureReward(result.tid, options.uploader, textureFingerprint(data), 0);
        result.status = 'imported';
      });
    } catch (error: any) { result.status = 'invalid'; result.reason = error.message; }
  }
  return results;
}
