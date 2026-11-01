import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { exec, pool } from '../src/db.js';
import { config } from '../src/config.js';

if (!process.argv.includes('--apply')) {
  console.log('Run npm run migrate -- --apply to add missing compatibility and extension tables without altering original columns. Add --long-descriptions only to opt into VARCHAR(255) -> TEXT.');
  process.exit(0);
}
try {
  // Vanilla Blessing Skin may not have tables supplied by its optional plugins.
  // Add only missing tables; never replay framework migration history or replace data.
  const connection=await pool.getConnection(),prefix=config.db.tablePrefix;
  const quote=(value:string)=>{if(!/^[A-Za-z0-9_]+$/.test(value))throw new Error('Invalid table identifier');return '`'+value+'`';};
  try{
    const [rows]:any=await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    const existing=new Set(rows.map((row:any)=>row.name));
    const missing=['users','players','textures','options','user_closet'].filter(name=>!existing.has(prefix+name));
    if(missing.length)throw new Error('Missing original site tables: '+missing.join(', ')+'. For an empty installation use db:init; for migration verify the database and table prefix. No changes were made.');
    const statements=(await fs.readFile('schema.sql','utf8')).replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*--.*$/gm,'').split(';').map(sql=>sql.trim()).filter(Boolean);
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    for(const statement of statements){
      const name=/^CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)`?/i.exec(statement)?.[1];
      if(!name)throw new Error('Unexpected compatibility schema statement');
      if(existing.has(prefix+name)||['_prisma_migrations','migrations'].includes(name))continue;
      const sql=statement.replace(/^CREATE TABLE\s+/i,'CREATE TABLE IF NOT EXISTS ')
        .replace(/\b(CREATE TABLE(?: IF NOT EXISTS)?|REFERENCES)\s+`?(\w+)`?/gi,(_,operation,table)=>operation+' '+quote(prefix+table))
        .replace(/\bCONSTRAINT\s+`([^`]+)`/gi,(_,constraint)=>'CONSTRAINT '+quote(prefix?(prefix+constraint).slice(0,45)+'_'+crypto.createHash('sha256').update(constraint).digest('hex').slice(0,12):constraint));
      await connection.query(sql);
      console.log('Added missing compatibility table '+name+'.');
    }
  }finally{await connection.query('SET FOREIGN_KEY_CHECKS=1');connection.release();}
  for (const name of (await fs.readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
    if(name==='003_texture_description.sql'&&!process.argv.includes('--long-descriptions')){console.log('Skipped optional '+name+' (enable with --long-descriptions).');continue;}
    const content = (await fs.readFile(`migrations/${name}`, 'utf8')).replace(/^\s*--.*$/gm, '');
    for (const sql of content.split(';').map(s => s.trim()).filter(Boolean)) await exec(sql);
    console.log(`Applied ${name} (${config.db.tablePrefix || 'original table names'}).`);
  }
} finally { await pool.end(); }
