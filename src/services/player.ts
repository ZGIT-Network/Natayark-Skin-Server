import { query, queryOne, exec, insert, nowString, withTransaction } from '../db.js';
import { getOption, getOptionBool, getOptionInt } from './option.js';
import { validatePlayerName } from '../util.js';
import { allocateUuid, deleteUuidRecordsByName, renameUuidRecord } from './uuid.js';
import type { Texture } from './texture.js';

export type Player = {
  pid: number;
  uid: number;
  name: string;
  tid_skin: number;
  tid_cape: number;
  last_modified: string;
};

export type PlayerWithName = Player & { skin?: Texture | null; cape?: Texture | null; model?: string };

export async function findPlayerByPid(pid: number): Promise<Player | null> {
  return queryOne<Player>('SELECT * FROM players WHERE pid = ?', [pid]);
}

export async function findPlayerByName(name: string): Promise<Player | null> {
  return queryOne<Player>('SELECT * FROM players WHERE name = ? LIMIT 1', [name]);
}

export async function listPlayersOfUser(uid: number): Promise<Player[]> {
  return query<Player>('SELECT * FROM players WHERE uid = ? ORDER BY pid ASC', [uid]);
}

export async function countPlayersOfUser(uid: number): Promise<number> {
  const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM players WHERE uid = ?', [uid]);
  return row?.c ?? 0;
}

export type AddPlayerResult =
  | { ok: true; player: Player; uuid: string }
  | { ok: false; reason: 'invalid_name' | 'dup_name' | 'limit_reached' | 'score_not_enough' };

export async function addPlayer(uid: number, name: string): Promise<AddPlayerResult> {
  if (await singlePlayerLimitEnabled()) return { ok: false, reason: 'limit_reached' };
  return createPlayer(uid, name, false);
}

/** Free initial binding used by the existing single-player-limit plugin. */
export async function bindSinglePlayer(uid: number, name: string): Promise<AddPlayerResult> {
  return createPlayer(uid, name, true);
}

export async function singlePlayerLimitEnabled(): Promise<boolean> {
  try {
    const plugins = JSON.parse(await getOption('plugins_enabled', '{}'));
    return Array.isArray(plugins) ? plugins.includes('single-player-limit') : Object.hasOwn(plugins, 'single-player-limit');
  } catch { return false; }
}

async function createPlayer(uid: number, name: string, initialBinding: boolean): Promise<AddPlayerResult> {
  const trimmed = name.trim();
  if (!validatePlayerName(trimmed)) return { ok: false, reason: 'invalid_name' };
  const cost = initialBinding ? 0 : await getOptionInt('score_per_player', 100);
  return withTransaction<AddPlayerResult>(async () => {
    const user = await queryOne<{ score: number; permission: number }>('SELECT score, permission FROM users WHERE uid = ? FOR UPDATE', [uid]);
    if (!user || user.permission < 0) return { ok: false, reason: 'invalid_name' };
    if (initialBinding && await countPlayersOfUser(uid) > 0) return { ok: false, reason: 'limit_reached' };
    if (await queryOne('SELECT pid FROM players WHERE name = ? FOR UPDATE', [trimmed])) return { ok: false, reason: 'dup_name' };
    if (user.score < cost) return { ok: false, reason: 'score_not_enough' };
    const pid = await insert('INSERT INTO players (uid, name, tid_skin, tid_cape, last_modified) VALUES (?, ?, 0, 0, ?)', [uid, trimmed, nowString()]);
    const uuid = await allocateUuid(trimmed);
    if (cost) await exec('UPDATE users SET score = score - ? WHERE uid = ?', [cost, uid]);
    if (initialBinding) await exec('UPDATE users SET nickname = ? WHERE uid = ?', [trimmed, uid]);
    return { ok: true, player: (await findPlayerByPid(pid))!, uuid };
  });
}

export async function renamePlayer(player: Player, newName: string): Promise<{ ok: boolean; reason?: 'invalid_name' | 'dup_name' }> {
  const trimmed = newName.trim();
  if (!validatePlayerName(trimmed)) return { ok: false, reason: 'invalid_name' };
  return withTransaction(async () => {
    await queryOne('SELECT uid FROM users WHERE uid = ? FOR UPDATE', [player.uid]);
    const current = await queryOne<Player>('SELECT * FROM players WHERE pid = ? FOR UPDATE', [player.pid]);
    if (!current) return { ok: false, reason: 'invalid_name' as const };
    if (trimmed === current.name) return { ok: true };
    const dup = await queryOne<Player>('SELECT * FROM players WHERE name = ? FOR UPDATE', [trimmed]);
    if (dup && dup.pid !== current.pid) return { ok: false, reason: 'dup_name' as const };
    const { getUuidByName } = await import('./uuid.js');
    const uuid = await getUuidByName(current.name);
    await exec('UPDATE players SET name = ?, last_modified = ? WHERE pid = ?', [trimmed, nowString(), current.pid]);
    if (uuid) await renameUuidRecord(uuid, trimmed);
    else await allocateUuid(trimmed);
    await (await import('./token.js')).revokeAllTokensForUser(current.uid);
    if (await singlePlayerLimitEnabled()) await exec('UPDATE users SET nickname = ? WHERE uid = ?', [trimmed, current.uid]);
    return { ok: true };
  });
}

export async function deletePlayer(player: Player, options: { bypassLimit?: boolean } = {}): Promise<void> {
  if (!options.bypassLimit && await singlePlayerLimitEnabled()) {
    throw Object.assign(new Error('本站启用了单角色限制，不能删除角色'), { statusCode: 403 });
  }
  // Admin deletion in PlayersManagementController never refunds the owner.
  const refund = !options.bypassLimit && await getOptionBool('return_score', false) ? await getOptionInt('score_per_player', 100) : 0;
  await withTransaction(async () => {
    await queryOne('SELECT uid FROM users WHERE uid = ? FOR UPDATE', [player.uid]);
    const current = await queryOne<Player>('SELECT * FROM players WHERE pid = ? FOR UPDATE', [player.pid]);
    if (!current) return;
    await exec('DELETE FROM players WHERE pid = ?', [current.pid]);
    await deleteUuidRecordsByName(current.name);
    if (refund) await exec('UPDATE users SET score = score + ? WHERE uid = ?', [refund, current.uid]);
  });
}

export async function setPlayerTexture(player: Player, type: 'skin' | 'cape', tid: number): Promise<void> {
  const column = type === 'skin' ? 'tid_skin' : 'tid_cape';
  await withTransaction(async () => {
    const texture = await queryOne<Texture>('SELECT * FROM textures WHERE tid = ? FOR UPDATE', [tid]);
    if (!texture || (type === 'cape') !== (texture.type === 'cape')) throw Object.assign(new Error('材质不存在或类型不符'), { statusCode: 400 });
    await exec(`UPDATE players SET ${column} = ?, last_modified = ? WHERE pid = ?`, [tid, nowString(), player.pid]);
  });
}

export async function clearPlayerTexture(player: Player, type: 'skin' | 'cape'): Promise<void> {
  const column = type === 'skin' ? 'tid_skin' : 'tid_cape';
  await exec(`UPDATE players SET ${column} = 0, last_modified = ? WHERE pid = ?`, [nowString(), player.pid]);
}

/** Load skin/cape textures for players in bulk. */
export async function attachTextures(players: Player[]): Promise<PlayerWithName[]> {
  const tids = new Set<number>();
  for (const p of players) {
    if (p.tid_skin > 0) tids.add(p.tid_skin);
    if (p.tid_cape > 0) tids.add(p.tid_cape);
  }
  const textures = new Map<number, Texture>();
  if (tids.size > 0) {
    const placeholders = [...tids].map(() => '?').join(',');
    const rows = await query<Texture>(`SELECT * FROM textures WHERE tid IN (${placeholders})`, [...tids]);
    for (const row of rows) textures.set(row.tid, row);
  }
  return players.map((p) => {
    const skin = p.tid_skin > 0 ? textures.get(p.tid_skin) ?? null : null;
    const cape = p.tid_cape > 0 ? textures.get(p.tid_cape) ?? null : null;
    const model = skin ? (skin.type === 'alex' ? 'slim' : 'default') : 'default';
    return { ...p, skin, cape, model };
  });
}

/** Stats for admin dashboard. */
export async function countPlayers(): Promise<number> {
  const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM players');
  return row?.c ?? 0;
}
