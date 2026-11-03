import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, insert, nowString, pool } from '../src/db.js';
import { issueAccessToken, getSystemClientId, SCOPES } from '../src/services/token.js';

assert.match(config.db.tablePrefix,/^dev_/,'Client acceptance requires an isolated dev_ database prefix');
const directory=path.resolve('.test-artifacts/friends-authlib');
async function fetchJson(url:string){const response=await fetch(url,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,url);return response.json() as Promise<any>;}
async function dependencies(version:string):Promise<string[]> {
  await fs.mkdir(directory,{recursive:true});
  const manifest=await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const entry=manifest.versions.find((entry:any)=>entry.id===version);assert.ok(entry);
  const details=await fetchJson(entry.url);
  const libraries=details.libraries.filter((library:any)=>/^(com.mojang:authlib:|com.google.code.gson:gson:|com.google.guava:guava:|com.google.guava:failureaccess:|org.slf4j:slf4j-api:|org.apache.commons:commons-lang3:|commons-io:commons-io:)/.test(library.name));
  return Promise.all(libraries.map(async(library:any)=>{
    const artifact=library.downloads.artifact,file=path.join(directory,path.basename(artifact.path));
    let data:Buffer|undefined;try{data=await fs.readFile(file);}catch{}
    if(!data||crypto.createHash('sha1').update(data).digest('hex')!==artifact.sha1){
      const response=await fetch(artifact.url,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);data=Buffer.from(await response.arrayBuffer());
      assert.equal(crypto.createHash('sha1').update(data).digest('hex'),artifact.sha1,'Official library checksum');await fs.writeFile(file,data);
    }
    return file;
  }));
}
async function command(program:string,args:string[],input=''):Promise<string>{
  return new Promise((resolve,reject)=>{
    const executable=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',program+(process.platform==='win32'?'.exe':'')):program;
    const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',error=>{clearTimeout(timer);reject(error);});child.stdin.on('error',reject);
    const timer=setTimeout(()=>{child.kill();reject(new Error(program+' timed out: '+stderr));},30000);
    child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(program+' failed: '+stderr));else resolve(stdout);});child.stdin.end(input);
  });
}
test('unmodified Minecraft 26.2 and 26.3 authlib friends clients use this server over HTTP',{timeout:180000},async t=>{
  const migration=await fs.readFile(new URL('../migrations/004_minecraft_friends.sql',import.meta.url),'utf8');
  for(const sql of migration.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await exec(sql);
  const app=await createApp(),uids:number[]=[],names:string[]=[],jtis:string[]=[];
  app.get('/__discovery',async()=>{
    const base=origin+'/api/yggdrasil/minecraftservices';
    const endpoints=Object.fromEntries(Object.entries({getFriends:'/friends',updateFriends:'/friends',getAttributes:'/player/attributes',updateAttributes:'/player/attributes',updatePresence:'/presence',getBlocklist:'/privacy/blocklist'}).map(([name,url])=>[name,{uri:base+url}]));
    return {environment:'test',product:'minecraft',discovery:{player:{endpoints}}};
  });
  let origin='';
  try{
    await app.listen({host:'127.0.0.1',port:0});origin='http://127.0.0.1:'+(app.server.address() as any).port;
    for(const version of ['26.2','26.3'])await t.test(version,async()=>{
      const libs=await dependencies(version),classpath=libs.join(path.delimiter);
      await command('javac',['-cp',classpath,'-d',directory,'tests/fixtures/FriendsAuthlibClient.java']);
      const suffix=crypto.randomBytes(4).toString('hex'),players=[];
      for(let i=0;i<2;i++){
        const name='Java'+suffix+i;names.push(name);
        const uid=await insert('INSERT INTO users (email,nickname,score,password,ip,last_sign_at,register_at,verified) VALUES (?,?,10000,?,?,?, ?,1)',[name+'@example.invalid',name,'fixture-hash','127.0.0.1',nowString(),nowString()]);uids.push(uid);
        await exec('INSERT INTO players (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,0,0,?)',[uid,name,nowString()]);
        const id=crypto.randomUUID();await exec('INSERT INTO `uuid` (name,uuid) VALUES (?,?)',[name,id.replace(/-/g,'')]);
        const token=await issueAccessToken({userId:uid,clientId:await getSystemClientId(),selectedProfile:id.replace(/-/g,''),scopes:[SCOPES.PROFILE_SELECT,SCOPES.SERVER_JOIN]});jtis.push(token.jti);players.push({name,id,token:token.jwt});
      }
      const input=[origin,players[0].token,players[1].token,players[0].id,players[1].id,players[1].name,''].join('\n');
      const result=await command('java',['-cp',[directory,...libs].join(path.delimiter),'FriendsAuthlibClient'],input);
      assert.match(result,/AUTHLIB_FRIENDS_OK \d+/);t.diagnostic(version+': '+result.trim());
    });
  }finally{
    for(const jti of jtis){await exec('DELETE FROM oauth_refresh_tokens WHERE access_token_id=?',[jti]);await exec('DELETE FROM oauth_access_tokens WHERE id=?',[jti]);}
    for(const uid of uids){await exec('DELETE FROM players WHERE uid=?',[uid]);await exec('DELETE FROM users WHERE uid=?',[uid]);}
    for(const name of names)await exec('DELETE FROM `uuid` WHERE name=?',[name]);await app.close();await pool.end();
  }
});
