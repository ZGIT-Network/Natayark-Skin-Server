const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const mysql = await import('mysql2/promise');
const bcrypt = (await import('bcryptjs')).default;
const cookies = new Map();
function cookieHeader() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(path, opts = {}) {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie: cookieHeader() } });
  for (const raw of r.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return r;
}
const conn = await mysql.createConnection({ host: '127.0.0.1', user: 'mcnskin', password: '123456', database: 'mcnskin' });
const prefix = process.env.DB_TABLE_PREFIX ?? 'dev_20261029_';
const users = `\`${prefix}users\``;
const email = 'ui-test@test.local';
const hash = bcrypt.hashSync('ui-test-password-123', 10).replace(/^\$2[ab]\$/, '$2y$');
const [rows] = await conn.query(`SELECT uid FROM ${users} WHERE email = ?`, [email]);
if (rows.length) {
  await conn.query(`UPDATE ${users} SET password = ?, permission = 2, verified = 1 WHERE uid = ?`, [hash, rows[0].uid]);
} else {
  await conn.query(`INSERT INTO ${users} (email,nickname,locale,score,avatar,password,ip,is_dark_mode,permission,last_sign_at,register_at,verified,verification_token) VALUES (?,?,?,?,0,?,?,0,2,?,?,1,'')`, [email, 'UI Test', 'zh_CN', 9999, hash, '127.0.0.1', '2024-01-01 00:00:00', new Date().toISOString().slice(0, 19).replace('T', ' ')]);
}
await conn.end();

const loginPage = await req('/auth/login');
let html = await loginPage.text();
if (loginPage.status !== 200) { console.log('login page', loginPage.status, html.slice(0, 200)); process.exit(1); }
const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
console.log('csrf?', !!csrf);
const login = await req('/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, email, password: 'ui-test-password-123' }).toString() });
console.log('login', login.status, login.headers.get('location'));
if (login.status !== 302) { console.log((await login.text()).replace(/\s+/g, ' ').slice(0, 500)); process.exit(1); }

const pages = ['/', '/skinlib', '/skinlib/upload', '/user', '/user/player', '/user/closet', '/user/profile', '/user/connections', '/user/applications', '/user/config', '/user/verification', '/user/sharing', '/admin', '/admin/users', '/admin/players', '/admin/textures', '/admin/reports', '/admin/settings', '/admin/clients', '/admin/ygg-log', '/admin/translations', '/auth/login', '/auth/forgot', '/auth/logout', '/connect/device'];
for (const p of pages) {
  const r = await req(p);
  let body = '';
  if (r.status >= 400) body = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
  console.log(String(r.status).padEnd(4), p, body);
}
const texture = await req('/skinlib/show/1');
console.log(texture.status, '/skinlib/show/1', texture.status >= 400 ? (await texture.text()).replace(/\s+/g, ' ').slice(0, 200) : '');
