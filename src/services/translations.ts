import { query, queryOne, exec, insert, nowString, withTransaction } from '../db.js';
import { translate, type Locale } from '../i18n.js';

export type TranslationLine = { id: number; group: string; key: string; text: Record<string, string>; created_at: string | null; updated_at: string | null };
let overrides = new Map<string, Record<string, string>>();
let loadedAt = 0;

function textObject(value: unknown): Record<string, string> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

export async function loadTranslationOverrides(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 30_000) return;
  const rows = await query<any>('SELECT `group`,`key`,text FROM language_lines ORDER BY id');
  const next = new Map<string, Record<string, string>>();
  for (const row of rows) next.set(`${row.group}.${row.key}`, textObject(row.text));
  overrides = next;
  loadedAt = Date.now();
}

/** Synchronous lookup after loadTranslationOverrides has refreshed the cache. */
export function translated(locale: Locale, key: string): string {
  const line = overrides.get(key);
  return line?.[locale] ?? line?.zh_CN ?? translate(locale, key);
}

export async function translationLines(page = 1): Promise<{ data: TranslationLine[]; current_page: number; per_page: number; last_page: number; total: number }> {
  page = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
  const total = (await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM language_lines'))?.c ?? 0;
  const rows = await query<any>('SELECT * FROM language_lines ORDER BY id DESC LIMIT 10 OFFSET ?', [(page - 1) * 10]);
  return { data: rows.map((row) => ({ ...row, text: textObject(row.text) })), current_page: page, per_page: 10, last_page: Math.max(1, Math.ceil(total / 10)), total };
}

function valid(group: string, key: string, locale: string, text: string): void {
  if (!group || group.length > 255 || !key || key.length > 255 || !/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/.test(locale) || !text || text.length > 100_000) throw Object.assign(new Error('翻译分组、键名、语言或内容无效'), { statusCode: 400 });
}

export async function createTranslationLine(group: string, key: string, locale: string, text: string): Promise<number> {
  valid(group, key, locale, text);
  const now = nowString();
  const id = await insert('INSERT INTO language_lines (`group`,`key`,text,created_at,updated_at) VALUES (?,?,?,?,?)', [group, key, JSON.stringify({ [locale]: text }), now, now]);
  loadedAt = 0;
  return id;
}

export async function updateTranslationLine(id: number, locale: string, text: string): Promise<boolean> {
  const changed = await withTransaction(async () => {
    const line = await queryOne<any>('SELECT * FROM language_lines WHERE id = ? FOR UPDATE', [id]);
    if (!line) return false;
    valid(line.group, line.key, locale, text);
    const values = { ...textObject(line.text), [locale]: text };
    await exec('UPDATE language_lines SET text = ?, updated_at = ? WHERE id = ?', [JSON.stringify(values), nowString(), id]);
    return true;
  });
  if (changed) loadedAt = 0;
  return changed;
}

export async function deleteTranslationLine(id: number): Promise<boolean> {
  const deleted = (await exec('DELETE FROM language_lines WHERE id = ?', [id])).affectedRows > 0;
  if (deleted) loadedAt = 0;
  return deleted;
}
