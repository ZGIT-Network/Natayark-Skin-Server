import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {config} from '../src/config.js';
import {pool} from '../src/db.js';

test('empty installation and concurrent first startup preserve one shared signing identity',{skip:!config.db.tablePrefix.startsWith('dev_'),timeout:60000},async()=>{
 const prefix='dev_keys_'+crypto.randomBytes(4).toString('hex')+'_',storage=await fs.mkdtemp(path.join(os.tmpdir(),'natayark-first-start-')),workers:ChildProcess[]=[];
 const env={...process.env,DB_TABLE_PREFIX:prefix,STORAGE_DIR:storage,MAIL_HOST:'',MAIL_FROM_ADDRESS:''};
 const launch=()=>new Promise<{child:ChildProcess;origin:string}>((resolve,reject)=>{
  const child=fork('tests/fixtures/http-worker.ts',[],{execArgv:['--import','tsx'],silent:true,env});workers.push(child);let stderr='';child.stderr?.on('data',chunk=>stderr+=chunk);
  const timer=setTimeout(()=>reject(new Error('Cold-start worker timed out: '+stderr)),20000);
  child.once('error',reject);child.once('message',(message:any)=>{clearTimeout(timer);resolve({child,origin:'http://127.0.0.1:'+message.port});});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Cold-start worker exited: '+stderr));});
 });
 const stop=async(child:ChildProcess)=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.send('stop');let timer:NodeJS.Timeout;try{await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},5000);})]);}finally{clearTimeout(timer!);}};
 try{
  const initialized=spawnSync(process.execPath,['--import','tsx','scripts/initialize.ts','--apply'],{env,encoding:'utf8'});assert.equal(initialized.status,0,initialized.stderr);
  const [a,b]=await Promise.all([launch(),launch()]);
  const [metadataA,metadataB,jwksA,jwksB]=await Promise.all([fetch(a.origin+'/api/yggdrasil').then(r=>r.json()),fetch(b.origin+'/api/yggdrasil').then(r=>r.json()),fetch(a.origin+'/connect/jwks').then(r=>r.json()),fetch(b.origin+'/connect/jwks').then(r=>r.json())]) as any[];
  assert.ok(metadataA.signaturePublickey);assert.equal(metadataA.signaturePublickey,metadataB.signaturePublickey);assert.deepEqual(jwksA,jwksB);assert.equal(jwksA.keys.length,1);
  const registration=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {registerUser} from './src/services/user.ts';import {pool} from './src/db.ts';const result=await registerUser({email:'first-start@example.test',nickname:'First admin',player_name:'ColdStartUser',password:'first-start-fixture-password',verified:true});if(!result.ok)throw new Error('Fixture registration failed');await pool.end();"],{env,encoding:'utf8'});assert.equal(registration.status,0,registration.stderr);
  const dry=spawnSync(process.execPath,['--import','tsx','scripts/promote-admin.ts','--email','first-start@example.test'],{env,encoding:'utf8'});assert.equal(dry.status,0,dry.stderr);
  const [before]:any=await pool.query('SELECT permission FROM `'+prefix+'users` WHERE email=?',['first-start@example.test']);assert.equal(before[0].permission,0);
  const promoted=spawnSync(process.execPath,['--import','tsx','scripts/promote-admin.ts','--email','first-start@example.test','--apply'],{env,encoding:'utf8'});assert.equal(promoted.status,0,promoted.stderr);
  const [after]:any=await pool.query('SELECT permission FROM `'+prefix+'users` WHERE email=?',['first-start@example.test']);assert.equal(after[0].permission,2);
  const repeated=spawnSync(process.execPath,['--import','tsx','scripts/initialize.ts','--apply'],{env,encoding:'utf8'});assert.notEqual(repeated.status,0);assert.match(repeated.stderr,/already contains tables/);
  assert.equal((await fetch(a.origin+'/api/yggdrasil').then(r=>r.json()) as any).signaturePublickey,metadataA.signaturePublickey);
 }finally{
  await Promise.all(workers.map(stop));
  const connection=await pool.getConnection();try{
   const [rows]:any=await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE ?',[prefix+'%']);
   await connection.query('SET FOREIGN_KEY_CHECKS=0');for(const row of rows){assert.ok(/^dev_keys_[a-f0-9]{8}_$/.test(prefix)&&row.name.startsWith(prefix)&&/^[A-Za-z0-9_]+$/.test(row.name));await connection.query('DROP TABLE `'+row.name+'`');}
   await connection.query('SET FOREIGN_KEY_CHECKS=1');
  }finally{connection.release();await pool.end();}
  assert.equal(path.dirname(path.resolve(storage)),path.resolve(os.tmpdir()));assert.ok(path.basename(storage).startsWith('natayark-first-start-'));await fs.rm(storage,{recursive:true});
 }
});
