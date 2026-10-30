import { exec, nowString } from '../db.js';
import { queryOne } from '../db.js';

/** Write a row into the `ygg_log` table (same columns the old plugin used). */
export async function yggLog(entry: {
  action: string;
  user_id?: number | null;
  player_id?: number | null;
  parameters?: any;
  ip?: string;
}): Promise<void> {
  let parameters = '';
  if (entry.parameters !== undefined) {
    parameters = typeof entry.parameters === 'string' ? entry.parameters : JSON.stringify(entry.parameters);
    if (parameters.length > 255) parameters = parameters.slice(0, 255);
  }
  try {
    await exec(
      'INSERT INTO ygg_log (action, user_id, player_id, parameters, ip, time) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.action, entry.user_id ?? 0, entry.player_id ?? 0, parameters, entry.ip ?? '', nowString()]
    );
  } catch {
    // logging must never break the API
  }
}

export async function getRemoteIpFromRequest(headers: Record<string, any>, remoteAddress: string): Promise<string> {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return remoteAddress ?? '';
}
