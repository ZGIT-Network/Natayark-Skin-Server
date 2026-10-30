import fs from 'node:fs/promises';
import { exec, pool } from '../src/db.js';
import { config } from '../src/config.js';

if (!process.argv.includes('--apply')) {
  console.log('Review migrations/*.sql and back up your database, then run npm run migrate -- --apply. Only additive extension tables are created.');
  process.exit(0);
}
try {
  for (const name of (await fs.readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
    const content = (await fs.readFile(`migrations/${name}`, 'utf8')).replace(/^\s*--.*$/gm, '');
    for (const sql of content.split(';').map(s => s.trim()).filter(Boolean)) await exec(sql);
    console.log(`Applied ${name} (${config.db.tablePrefix || 'original table names'}).`);
  }
} finally { await pool.end(); }
