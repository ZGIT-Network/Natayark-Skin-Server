import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {config} from '../src/config.js';
import {pool} from '../src/db.js';
import {fixtureSchema} from './fixture-schema.js';

test('legacy migration fills missing plugin tables without changing existing schema or data',{skip:!config.db.tablePrefix.startsWith('dev_'),timeout:60000},async()=>{
 const prefix='dev_migrate_'+crypto.randomBytes(4).toString('hex')+'_';
 const env={...process.env,DB_TABLE_PREFIX:prefix,MAIL_HOST:'',MAIL_FROM_ADDRESS:''};
 const run=(...args:string[])=>spawnSync(process.execPath,['--import','tsx','scripts/migrate.ts',...args],{env,encoding:'utf8'});
 const quote=(table:string)=>{assert.match(table,/^[A-Za-z0-9_]+$/);assert.ok(table.startsWith(prefix));return '`'+table+'`';};
 const list=async()=>{const [rows]:any=await pool.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,?)=?',[prefix.length,prefix]);return rows.map((row:any)=>row.name) as string[];};
 const core=['users','players','textures','options','user_closet'];
 try{
  const empty=run('--apply');assert.notEqual(empty.status,0);assert.match(empty.stderr,/Missing original site tables/);assert.deepEqual(await list(),[]);
  for(const table of core)await pool.query(fixtureSchema(table).replace('`'+table+'`',quote(prefix+table)));
  await pool.query('INSERT INTO '+quote(prefix+'options')+' (option_name,option_value) VALUES (?,?)',['migration_sentinel','unchanged']);
  const [created]:any=await pool.query('INSERT INTO '+quote(prefix+'users')+' (email,nickname,score,password,ip,last_sign_at,register_at) VALUES (?,?,?,?,?,?,?)',['migration@example.test','Legacy user',618,'preserved-fixture-hash','127.0.0.1','2026-01-01 00:00:00','2025-01-01 00:00:00']);
  await pool.query('INSERT INTO '+quote(prefix+'players')+' (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,0,0,?)',[created.insertId,'LegacyMigration','2026-01-01 00:00:00']);
  const dataBefore=await Promise.all(core.map(async table=>(await pool.query('SELECT * FROM '+quote(prefix+table)))[0]));
  const before=await Promise.all(core.map(async table=>{const [rows]:any=await pool.query('SHOW CREATE TABLE '+quote(prefix+table));return rows[0]['Create Table'];}));
  const dry=run();assert.equal(dry.status,0,dry.stderr);assert.equal((await list()).length,core.length);
  const applied=run('--apply');assert.equal(applied.status,0,applied.stderr);
  const tables=await list();for(const table of ['uuid','oauth_clients','yggc_grants','mcn_web_sessions','mcn_registration_rewards'])assert.ok(tables.includes(prefix+table));
  assert.ok(!tables.includes(prefix+'_prisma_migrations'));assert.ok(!tables.includes(prefix+'migrations'));
  const after=await Promise.all(core.map(async table=>{const [rows]:any=await pool.query('SHOW CREATE TABLE '+quote(prefix+table));return rows[0]['Create Table'];}));
  assert.deepEqual(after,before);
  assert.deepEqual(await Promise.all(core.map(async table=>(await pool.query('SELECT * FROM '+quote(prefix+table)))[0])),dataBefore);
  const [sentinel]:any=await pool.query('SELECT option_value FROM '+quote(prefix+'options')+' WHERE option_name=?',['migration_sentinel']);assert.equal(sentinel[0].option_value,'unchanged');
  const repeated=run('--apply');assert.equal(repeated.status,0,repeated.stderr);assert.deepEqual((await list()).sort(),tables.sort());
  const [foreign]:any=await pool.query('SELECT REFERENCED_TABLE_NAME AS referenced FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL',[prefix+'code_id_to_uuid']);
  assert.equal(foreign[0].referenced,prefix+'oauth_auth_codes');
 }finally{
  const connection=await pool.getConnection();try{
   await connection.query('SET FOREIGN_KEY_CHECKS=0');
   for(const table of await list()){assert.match(prefix,/^dev_migrate_[a-f0-9]{8}_$/);await connection.query('DROP TABLE '+quote(table));}
  }finally{await connection.query('SET FOREIGN_KEY_CHECKS=1');connection.release();await pool.end();}
 }
});
