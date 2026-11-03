import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import {config} from '../src/config.js';

const contents=await Promise.all(['schema.sql','migrations/001_auth_extensions.sql','migrations/002_registration_rewards.sql','migrations/004_minecraft_friends.sql'].map(name=>fs.readFile(name,'utf8')));
const statements=contents.flatMap(content=>content.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*--.*$/gm,'').split(';').map(value=>value.trim()).filter(Boolean));
const tableNames=statements.map(sql=>/^CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)`?/i.exec(sql)?.[1]).filter((value):value is string=>!!value);
if(tableNames.length!==statements.length||new Set(tableNames).size!==tableNames.length)throw new Error('Unexpected initialization schema');
if(!process.argv.includes('--apply')){
  console.log(`Initializes ${tableNames.length} tables in an empty database or namespace. Existing tables are never replaced. Run npm run db:init -- --apply for a new installation; use npm run migrate -- --apply for an existing site.`);
}else{
  const {tablePrefix:prefix,...database}=config.db;
  const connection=await mysql.createConnection({host:database.host,port:database.port,user:database.user,password:database.password,database:database.database});
  const quote=(value:string)=>{if(!/^[A-Za-z0-9_]+$/.test(value))throw new Error('Invalid table identifier');return '`'+value+'`';};
  try{
    const [rows]:any=await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if(rows.some((row:any)=>!prefix||row.name.startsWith(prefix)))throw new Error('Target database or namespace already contains tables. Initialization stopped without changing them; use migrations for an existing site.');
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    for(const statement of statements){
      const sql=statement.replace(/\b(CREATE TABLE(?: IF NOT EXISTS)?|REFERENCES)\s+`?(\w+)`?/gi,(_,operation,name)=>operation+' '+quote(prefix+name))
        .replace(/\bCONSTRAINT\s+`([^`]+)`/gi,(_,name)=>'CONSTRAINT '+quote(prefix?(prefix+name).slice(0,45)+'_'+crypto.createHash('sha256').update(name).digest('hex').slice(0,12):name));
      await connection.query(sql);
    }
    console.log(`Initialized ${tableNames.length} empty tables${prefix?' with prefix '+prefix:''}. No users or sample data were created.`);
  }finally{await connection.query('SET FOREIGN_KEY_CHECKS=1');await connection.end();}
}
