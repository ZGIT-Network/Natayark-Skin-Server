import { query, queryOne, exec } from '../db.js';
import { getOption } from './option.js';
import { offlineUuidV3Hex, uuid4Hex } from '../util.js';

/**
 * The `uuid` table maps player names to Yggdrasil UUIDs (32 hex chars, no dashes).
 *
 * Rows written by the old installation are authoritative:
 * - players verified via the mojang-verification plugin have their real Mojang UUID here;
 * - everyone else has uuid3("OfflinePlayer:" + name) or a random uuid4.
 *
 * New allocations follow option('ygg_uuid_algorithm'): 'v3' => offline v3 UUID, else random v4.
 */
export async function getUuidByName(name: string): Promise<string | null> {
  const row = await queryOne<{ uuid: string }>('SELECT uuid FROM `uuid` WHERE name = ? ORDER BY id ASC LIMIT 1', [name]);
  return row ? normalizeUuid(row.uuid) : null;
}

export function normalizeUuid(value: string): string | null {
  const uuid = value.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(uuid) ? uuid : null;
}

/** A display hint only; UUIDs remain public protocol identifiers. */
export function maskUuid(value: string | null | undefined): string {
  const uuid = value ? normalizeUuid(value) : null;
  return uuid ? `${uuid.slice(0, 4)}…${uuid.slice(-4)}` : '—';
}

export async function getNameByUuid(uuid: string): Promise<string | null> {
  const normalized = normalizeUuid(uuid);
  if (!normalized) return null;
  const row = await queryOne<{ name: string }>("SELECT name FROM `uuid` WHERE REPLACE(uuid, '-', '') = ? ORDER BY id ASC LIMIT 1", [normalized]);
  return row?.name ?? null;
}

/** Allocate a UUID for a new player name, following the configured algorithm. */
export async function allocateUuid(name: string): Promise<string> {
  const existing = await getUuidByName(name);
  if (existing) return existing;

  const algorithm = await getOption('ygg_uuid_algorithm', 'v3');
  const uuid = algorithm === 'v3' ? offlineUuidV3Hex(name) : uuid4Hex();
  await exec('INSERT INTO `uuid` (name, uuid) VALUES (?, ?)', [name, uuid]);
  return uuid;
}

/** Update the name recorded alongside a uuid (used when a player is renamed). */
export async function renameUuidRecord(uuid: string, newName: string): Promise<void> {
  await exec('UPDATE `uuid` SET name = ? WHERE uuid = ?', [newName, uuid]);
}

export async function deleteUuidRecordsByName(name: string): Promise<void> {
  await exec('DELETE FROM `uuid` WHERE name = ?', [name]);
}

export async function deleteUuidRecordsByUuid(uuid: string): Promise<void> {
  await exec('DELETE FROM `uuid` WHERE uuid = ?', [uuid]);
}

/** All (uuid, name) pairs for the given player names. */
export async function getUuidsForNames(names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.length === 0) return map;
  const placeholders = names.map(() => '?').join(',');
  const rows = await query<{ name: string; uuid: string }>(
    `SELECT name, uuid FROM \`uuid\` WHERE name IN (${placeholders})`,
    names
  );
  for (const row of rows) if (!map.has(row.name)) map.set(row.name, row.uuid);
  return map;
}
