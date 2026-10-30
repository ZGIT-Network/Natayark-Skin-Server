import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';

// Copy into an explicit namespace; never replace or mutate source tables.
const prefix = process.env.DB_TABLE_PREFIX;
if (!prefix || !/^dev_[a-zA-Z0-9_]{1,23}_$/.test(prefix)) throw new Error('Set a dev_*_ DB_TABLE_PREFIX first');
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
try {
  const [all] = await db.query('SHOW TABLES');
  const source = all.map(row => Object.values(row)[0]).filter(name => !name.startsWith('dev_') && !name.startsWith('mcn_'));
  const before = {};
  for (const table of source) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Unexpected table identifier');
    const [checksum] = await db.query(`CHECKSUM TABLE \`${table}\``);
    before[table] = checksum[0].Checksum;
    const [exists] = await db.query('SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?', [prefix + table]);
    if (exists.length) continue;
    await db.query(`CREATE TABLE \`${prefix}${table}\` LIKE \`${table}\``);
    await db.query(`INSERT INTO \`${prefix}${table}\` SELECT * FROM \`${table}\``);
  }
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/original-checksums.json', JSON.stringify(before, null, 2));
  console.log(`Prepared ${source.length} isolated tables; source tables unchanged. CREATE LIKE does not copy foreign keys.`);
} finally { await db.end(); }
