import { config } from '../../src/config.js';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.database });
const prefix = config.db.tablePrefix ?? '';
await conn.execute('UPDATE \`' + prefix + 'users\` SET permission = 2 WHERE email = ?', ['e2e-oauth@example.com']);
console.log('promoted');
await conn.end();
