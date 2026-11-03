import mysql2 from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import { formatLocalDate, parseLocalDate } from './services/datetime.js';

export const pool = mysql2.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 16,
  namedPlaceholders: true,
  supportBigNumbers: true,
  dateStrings: true, // keep DATETIME as 'YYYY-MM-DD HH:mm:ss' strings, matching PHP
});

export type Row = Record<string, any>;
export type RowOrNull = Row | undefined | null;
const transactionContext = new AsyncLocalStorage<mysql2.PoolConnection>();
type CommitTask = () => void | Promise<void>;
const commitTasks = new AsyncLocalStorage<CommitTask[]>();
const finishTasks = new AsyncLocalStorage<CommitTask[]>();
const tableNames = new Set(['users','players','textures','options','user_closet','uuid','reports','notifications','scopes','reg_link','mojang_verifications','textures_description','language_lines','jobs','ygg_log','oauth_clients','oauth_access_tokens','oauth_auth_codes','oauth_refresh_tokens','oauth_personal_access_clients','code_id_to_uuid','yggc_authorization_codes','yggc_device_codes','yggc_grants','yggc_interactions','yggc_refresh_tokens','yggc_sessions','mcn_oauth_identities','mcn_oauth_flows','mcn_email_challenges','mcn_web_sessions','mcn_registration_rewards','mcn_social_profiles','mcn_friendships','mcn_texture_rewards','mcn_texture_uploads']);
if (config.db.tablePrefix && !/^[a-zA-Z][a-zA-Z0-9_]{0,27}$/.test(config.db.tablePrefix)) throw new Error('Invalid DB_TABLE_PREFIX');

/** Optional isolated validation namespace; production defaults to original names. */
function namespacedSql(sql: string): string {
  if (!config.db.tablePrefix) return sql;
  return sql.replace(/\b(FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(`?)([a-zA-Z_][a-zA-Z0-9_]*)\2/gi, (match, keyword, _quote, name) =>
    tableNames.has(name.toLowerCase()) ? `${keyword} \`${config.db.tablePrefix}${name}\`` : match);
}

function scopedConnection(connection: mysql2.PoolConnection): mysql2.PoolConnection {
  return new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if ((property === 'query' || property === 'execute') && typeof value === 'function') {
        return (sql: string, ...args: unknown[]) => value.call(target, namespacedSql(sql), ...args);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function query<T = Row>(sql: string, params?: any[] | Record<string, any>): Promise<T[]> {
  const current = transactionContext.getStore();
  const [rows] = current ? await current.query(sql, params) : await pool.query(namespacedSql(sql), params);
  return rows as T[];
}

export async function queryOne<T = Row>(sql: string, params?: any[] | Record<string, any>): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function exec(sql: string, params?: any[] | Record<string, any>): Promise<mysql2.ResultSetHeader> {
  const current = transactionContext.getStore();
  const [result] = current ? await current.query(sql, params) : await pool.query(namespacedSql(sql), params);
  return result as mysql2.ResultSetHeader;
}

/** Insert helper returning insertId. */
export async function insert(sql: string, params?: any[] | Record<string, any>): Promise<number> {
  const result = await exec(sql, params);
  return result.insertId;
}

/** Run a set of statements inside a transaction. */
export async function transaction<T>(fn: (conn: mysql2.PoolConnection) => Promise<T>): Promise<T> {
  const current = transactionContext.getStore();
  if (current) return fn(current);
  const conn = scopedConnection(await pool.getConnection());
  const tasks: CommitTask[] = [];
  const finished: CommitTask[] = [];
  let result: T;
  try {
    await conn.beginTransaction();
    result = await transactionContext.run(conn, () => commitTasks.run(tasks, () => finishTasks.run(finished, () => fn(conn))));
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    let cleanupFailed = false;
    for (const task of finished) {
      try { await task(); } catch { cleanupFailed = true; console.error('A transaction cleanup task failed.'); }
    }
    if (cleanupFailed) conn.destroy(); else conn.release();
  }
  for (const task of tasks) {
    try { await task(); } catch { console.error('A post-commit task failed; committed database state was retained.'); }
  }
  return result;
}

/** Query helpers and nested services share this transaction's connection. */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()) return fn();
  for (let attempt = 0; ; attempt++) {
    try { return await transaction(() => fn()); }
    catch (error) { if (attempt >= 2 || !['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes((error as any).code)) throw error; }
  }
}

/** External side effects run only after the outer transaction commits. */
export function afterCommit(task: CommitTask): void {
  const tasks = commitTasks.getStore();
  if (tasks) tasks.push(task);
  else void Promise.resolve().then(task).catch(() => console.error('A post-commit task failed.'));
}

/** Release connection-scoped resources after commit OR rollback, before pooling. */
export function afterTransaction(task: CommitTask): void {
  const tasks = finishTasks.getStore();
  const connection = transactionContext.getStore();
  if (!tasks || !connection) throw new Error('A transaction is required');
  tasks.push(() => transactionContext.run(connection, task));
}

export function nowString(offsetSeconds = 0): string {
  return dateToLocalString(new Date(Date.now() + offsetSeconds * 1000));
}

export function nowDate(offsetSeconds = 0): Date {
  return new Date(Date.now() + offsetSeconds * 1000);
}

/** Format a Date as 'YYYY-MM-DD HH:mm:ss' in the configured timezone. */
export function dateToLocalString(d: Date): string {
  return formatLocalDate(d, config.tz);
}

/** Parse 'YYYY-MM-DD HH:mm:ss' (stored local time) back to a UTC epoch. */
export function localStringToEpoch(s: string): number {
  return parseLocalDate(s, config.tz);
}
