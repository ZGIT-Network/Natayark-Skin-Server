import { query, queryOne, exec, insert, nowString, transaction, localStringToEpoch } from '../db.js';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { hashPassword, verifyPassword } from './cipher.js';
import { getOption, getOptionInt, getOptionBool } from './option.js';
import { randomInt, randomToken, validatePlayerName, offlineUuidV3Hex, uuid4Hex } from '../util.js';
import { awardRegistrationShare } from './sharing.js';

export type User = {
  uid: number;
  email: string;
  nickname: string;
  locale: string | null;
  score: number;
  avatar: number;
  password: string;
  ip: string;
  is_dark_mode: number;
  permission: number;
  last_sign_at: string;
  register_at: string;
  verified: number;
  verification_token: string;
  remember_token: string | null;
};

export const PERMISSION_BANNED = -1;
export const PERMISSION_NORMAL = 0;
export const PERMISSION_ADMIN = 1;
export const PERMISSION_SUPER_ADMIN = 2;

export function isAdmin(user: User | null | undefined): boolean {
  return !!user && user.permission >= PERMISSION_ADMIN;
}

export async function findUserByUid(uid: number): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE uid = ?', [uid]);
}

export async function findUserByEmail(email: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE email = ?', [email]);
}

export function checkUserPassword(user: User, plain: string): boolean {
  return verifyPassword(plain, user.password);
}

export async function changeUserPassword(uid: number, plain: string): Promise<void> {
  const hash = await hashPassword(plain);
  await transaction(async conn => {
    await conn.query('UPDATE users SET password = ?, remember_token = NULL WHERE uid = ?', [hash, uid]);
    await conn.query('DELETE FROM mcn_web_sessions WHERE user_id = ?', [uid]);
    await conn.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE user_id = ?', [uid]);
    await conn.query('UPDATE oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id = r.access_token_id SET r.revoked = 1 WHERE a.user_id = ?', [uid]);
  });
}

export type RegisterInput = {
  email: string;
  nickname: string;
  password?: string;
  ip?: string;
  verified?: boolean;
  locale?: string;
  player_name?: string;
  share?: string;
};

export type RegisterResult =
  | { ok: true; user: User }
  | { ok: false; code: 'dup_email' | 'dup_player' | 'invalid_email' | 'invalid_player_name' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create a user. Mirrors BS core: nickname defaults to player name when
 * register_with_player_name is enabled; initial score from options.
 */
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  return transaction(conn => registerUserInTransaction(conn, input));
}

/** Also used by OAuth registration so user, player and identity commit together. */
export async function registerUserInTransaction(conn: PoolConnection, input: RegisterInput, preparedPasswordHash?: string): Promise<RegisterResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 100) return { ok: false, code: 'invalid_email' };

  const [existing] = await conn.query<any[]>('SELECT uid FROM users WHERE email = ? FOR UPDATE', [email]);
  if (existing.length) return { ok: false, code: 'dup_email' };

  const registerWithPlayerName = await getOptionBool('register_with_player_name', true);
  const nickname = (registerWithPlayerName ? input.player_name || input.nickname : input.nickname || email.split('@')[0]) || '';

  const initialScore = await getOptionInt('user_initial_score', 1000);
  const now = nowString();
  const playerName = input.player_name?.trim();
  if (playerName && !validatePlayerName(playerName)) return { ok: false, code: 'invalid_player_name' };
  if (playerName) {
    const [players] = await conn.query<any[]>('SELECT pid FROM players WHERE name = ? FOR UPDATE', [playerName]);
    if (players.length) return { ok: false, code: 'dup_player' };
  }
  const verified = input.verified ?? !(await getOptionBool('require_verification', false));
  const [created] = await conn.query<ResultSetHeader>(
    'INSERT INTO users (email, nickname, locale, score, avatar, password, ip, is_dark_mode, permission, last_sign_at, register_at, verified, verification_token) VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?, ?, ?)',
    [
      email,
      nickname.slice(0, 50),
      input.locale ?? null,
      initialScore,
      input.password ? await hashPassword(input.password) : preparedPasswordHash || '',
      input.ip ?? '',
      nowString(-86400),
      now,
      verified ? 1 : 0,
      '',
    ]
  );

  const uid = created.insertId;
  if (playerName) {
    const [player] = await conn.query<ResultSetHeader>('INSERT INTO players (uid, name, tid_skin, tid_cape, last_modified) VALUES (?, ?, 0, 0, ?)', [uid, playerName, now]);
    const [existingUuid] = await conn.query<any[]>('SELECT uuid FROM `uuid` WHERE name = ? FOR UPDATE', [playerName]);
    if (!existingUuid.length) {
      const uuid = (await getOption('ygg_uuid_algorithm', 'v3')) === 'v3' ? offlineUuidV3Hex(playerName) : uuid4Hex();
      const [columns] = await conn.query<any[]>("SHOW COLUMNS FROM `uuid` LIKE 'pid'");
      if (columns.length) await conn.query('INSERT INTO `uuid` (pid, name, uuid) VALUES (?, ?, ?)', [player.insertId, playerName, uuid]);
      else await conn.query('INSERT INTO `uuid` (name, uuid) VALUES (?, ?)', [playerName, uuid]);
    }
  }
  await awardRegistrationShare(uid, input.share);
  const [users] = await conn.query<any[]>('SELECT * FROM users WHERE uid = ?', [uid]);
  const user = users[0] as User;
  return { ok: true, user: user! };
}

/** Daily sign-in award, mirroring UserController@sign. */
export async function signUser(user: User): Promise<{ ok: boolean; acquired: number } | { ok: false; reason: 'too-early' }> {
  const signAfterZero = await getOptionBool('sign_after_zero', true);
  const gap = await getOptionInt('sign_gap_time', 24);

  const [minStr, maxStr] = (await getOption('sign_score', '10,100')).split(',');
  const min = parseInt(minStr, 10) || 0;
  const max = parseInt(maxStr ?? minStr, 10) || min;
  const acquired = randomInt(min, max);
  return transaction(async conn => {
    const [users] = await conn.query<any[]>('SELECT last_sign_at FROM users WHERE uid = ? FOR UPDATE', [user.uid]);
    if (!users.length) return { ok: false, reason: 'too-early' };
    const lastSign = String(users[0].last_sign_at);
    const canSign = signAfterZero ? lastSign.slice(0, 10) < nowString().slice(0, 10)
      : localStringToEpoch(lastSign) + gap * 3600_000 <= Date.now();
    if (!canSign) return { ok: false, reason: 'too-early' };
    await conn.query('UPDATE users SET score = score + ?, last_sign_at = ? WHERE uid = ?', [acquired, nowString(), user.uid]);
    return { ok: true, acquired };
  });
}

export async function addScore(uid: number, delta: number): Promise<void> {
  await exec('UPDATE users SET score = score + ? WHERE uid = ?', [delta, uid]);
}

export async function updateEmail(uid: number, email: string): Promise<void> {
  await exec('UPDATE users SET email = ? WHERE uid = ?', [email, uid]);
}
