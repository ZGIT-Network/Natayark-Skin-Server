// Fetch an authenticated page's HTML using a locally minted session.
import { config } from '../../src/config.js';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

function serialize(data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', config.appKey).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const SID = 'f'.repeat(64);
const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.database });
const prefix = config.db.tablePrefix ?? '';
const [rows] = await conn.execute('SELECT uid FROM \`' + prefix + 'users\` WHERE email = ?', ['e2e-oauth@example.com']);
await conn.execute('INSERT INTO \`' + prefix + 'mcn_web_sessions\` (sid_hash, user_id, created_at, expires_at) VALUES (?, ?, NOW(6), DATE_ADD(NOW(6), INTERVAL 1 HOUR)) ON DUPLICATE KEY UPDATE expires_at = DATE_ADD(NOW(6), INTERVAL 1 HOUR)', [crypto.createHash('sha256').update(SID).digest('hex'), rows[0].uid]);
await conn.end();
const cookie = serialize({ uid: rows[0].uid, iat: Math.floor(Date.now() / 1000), sid: SID });
const path = process.argv[2] ?? '/user/player';
const resp = await fetch('http://127.0.0.1:3000' + path, { headers: { Cookie: 'mcnskin_session=' + cookie } });
const html = await resp.text();
console.log('status', resp.status, 'len', html.length);
const needle = process.argv[3];
if (needle) {
  html.split('\n').forEach((l, i) => { if (l.includes(needle)) console.log(i + ': ' + l.trim().slice(0, 220)); });
} else {
  console.log(html);
}
