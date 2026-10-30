import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
const before = JSON.parse(await fs.readFile('artifacts/original-checksums.json', 'utf8'));
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
try {
  const changed = [];
  for (const [table, checksum] of Object.entries(before)) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Invalid identifier');
    const [rows] = await db.query(`CHECKSUM TABLE \`${table}\``);
    if (rows[0].Checksum !== checksum) changed.push(table);
  }
  if (changed.length) throw new Error('Original tables changed: ' + changed.join(', '));
  console.log(`Verified ${Object.keys(before).length} original table checksums unchanged.`);
} finally { await db.end(); }
