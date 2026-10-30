const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const cookies = new Map();
function cookieHeader() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(path, opts = {}) {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie: cookieHeader() } });
  for (const raw of r.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return r;
}
const email = `crawl-${Date.now()}@test.local`, password = 'crawl-password-123', name = `cr_${String(Date.now()).slice(-8)}`;
let html = await (await req('/auth/register')).text();
const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
const reg = await req('/auth/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, email, password, password_confirm: password, player_name: name }).toString() });
console.log('register', reg.status, email);
const mysql = await import('mysql2/promise');
const conn = await mysql.createConnection({ host: '127.0.0.1', user: 'mcnskin', password: '123456', database: 'mcnskin' });
await conn.query('UPDATE users SET permission = 2 WHERE email = ?', [email]);
await conn.end();
const pages = ['/', '/skinlib', '/skinlib/upload', '/user', '/user/player', '/user/closet', '/user/profile', '/user/connections', '/user/applications', '/user/config', '/user/verification', '/user/sharing', '/admin', '/admin/users', '/admin/players', '/admin/textures', '/admin/reports', '/admin/settings', '/admin/clients', '/admin/ygg-log', '/admin/i18n', '/auth/login', '/auth/register', '/auth/forgot', '/auth/logout', '/connect/device'];
for (const p of pages) {
  const r = await req(p);
  let body = '';
  if (r.status >= 400) body = (await r.text()).replace(/\s+/g, ' ').slice(0, 200);
  console.log(String(r.status).padEnd(4), p, body);
}
console.log('EMAIL', email);
