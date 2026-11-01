import crypto from 'node:crypto';
import { exec, insert, query, queryOne, nowString, withTransaction } from '../db.js';
import { getOption, getOptionInt } from './option.js';

export type RegistrationLink = { id: number; sharer: number; code: string; created_at: string; updated_at: string; url: string };

import { pluginEnabled } from './plugins.js';
export const sharingEnabled = () => pluginEnabled('share-registration-link');

async function withUrl(record: Omit<RegistrationLink, 'url'>): Promise<RegistrationLink> {
  const origin = (await getOption('site_url', '')).replace(/\/+$/, '');
  return { ...record, url: `${origin}/auth/register?share=${encodeURIComponent(record.code)}` };
}

export async function registrationLinks(uid: number): Promise<{ records: RegistrationLink[]; sharer: number; sharee: number }> {
  const rows = await query<Omit<RegistrationLink, 'url'>>('SELECT id,sharer,code,created_at,updated_at FROM reg_link WHERE sharer = ? ORDER BY id DESC', [uid]);
  return { records: await Promise.all(rows.map(withUrl)), sharer: await getOptionInt('reg_link_sharer_score', 50), sharee: await getOptionInt('reg_link_sharee_score', 0) };
}

export async function createRegistrationLink(uid: number): Promise<RegistrationLink> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const code = Array.from({ length: 20 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  const now = nowString();
  const id = await withTransaction(async () => {
    const owner = await queryOne<{ permission: number }>('SELECT permission FROM users WHERE uid = ? FOR UPDATE', [uid]);
    if (!owner || owner.permission < 0) throw Object.assign(new Error('该账号不能生成注册链接'), { statusCode: 403 });
    return insert('INSERT INTO reg_link (sharer,code,created_at,updated_at) VALUES (?,?,?,?)', [uid, code, now, now]);
  });
  return withUrl({ id, sharer: uid, code, created_at: now, updated_at: now });
}

export async function removeRegistrationLink(uid: number, id: number): Promise<boolean> {
  return (await exec('DELETE FROM reg_link WHERE id = ? AND sharer = ?', [id, uid])).affectedRows > 0;
}

/** Called inside the registration transaction; repeated calls cannot pay twice. */
export async function awardRegistrationShare(shareeUid: number, code?: string): Promise<{ awarded: boolean }> {
  if (!code || code.length > 255 || !(await sharingEnabled())) return { awarded: false };
  const sharerReward = await getOptionInt('reg_link_sharer_score', 50);
  const shareeReward = await getOptionInt('reg_link_sharee_score', 0);
  return withTransaction(async () => {
    const record = await queryOne<{ id: number; sharer: number }>('SELECT id,sharer FROM reg_link WHERE code = ? LIMIT 1 FOR UPDATE', [code]);
    if (!record || record.sharer === shareeUid) return { awarded: false };
    // Lock both balances in stable order. The recipient is also the idempotency
    // boundary, so two callbacks cannot race on an absent reward ledger row.
    const ids = [shareeUid, record.sharer].sort((a, b) => a - b);
    const users = await query<{ uid: number }>('SELECT uid FROM users WHERE uid IN (?,?) ORDER BY uid FOR UPDATE', ids);
    if (!users.some((u) => u.uid === shareeUid)) return { awarded: false };
    if (await queryOne('SELECT uid FROM mcn_registration_rewards WHERE uid = ?', [shareeUid])) return { awarded: false };
    await exec('INSERT INTO mcn_registration_rewards (uid,code_id,sharer,created_at) VALUES (?,?,?,?)', [shareeUid, record.id, record.sharer, nowString()]);
    if (users.some((u) => u.uid === record.sharer) && sharerReward) await exec('UPDATE users SET score = score + ? WHERE uid = ?', [sharerReward, record.sharer]);
    if (shareeReward) await exec('UPDATE users SET score = score + ? WHERE uid = ?', [shareeReward, shareeUid]);
    return { awarded: true };
  });
}
