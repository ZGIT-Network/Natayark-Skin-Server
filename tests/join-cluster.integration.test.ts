import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {config} from '../src/config.js';
import {queryOne,exec,pool,nowString} from '../src/db.js';
import {registerUser} from '../src/services/user.js';
import {issueAccessToken,getSystemClientId,revokeTokenRow,SCOPES} from '../src/services/token.js';
import {getUuidByName} from '../src/services/uuid.js';
import {joinSessionKey} from '../src/services/join-session.js';

test('Minecraft join survives cross-process routing and process restart, with expiry and revocation',{skip:!config.db.tablePrefix.startsWith('dev_'),timeout:60000},async()=>{
  const suffix=crypto.randomBytes(4).toString('hex'),name='Cluster'+suffix,serverId='cluster-'+suffix,workers:ChildProcess[]=[];let uid=0,profile='';
  const worker=async()=>{
    const child=fork('tests/fixtures/http-worker.ts',[],{execArgv:['--import','tsx'],silent:true,env:{...process.env,MAIL_HOST:'',MAIL_FROM_ADDRESS:''}});workers.push(child);
    let stderr='';child.stderr?.on('data',chunk=>{stderr+=chunk;});
    return new Promise<{child:ChildProcess;origin:string}>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('HTTP worker did not start: '+stderr)),15000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('HTTP worker exited: '+stderr));});
      child.once('message',(message:any)=>{clearTimeout(timeout);resolve({child,origin:'http://127.0.0.1:'+message.port});});
    });
  };
  const stop=async(child:ChildProcess)=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');let timeout:NodeJS.Timeout;child.send('stop');try{await Promise.race([exited,new Promise<void>(resolve=>{timeout=setTimeout(()=>{child.kill();resolve();},5000);})]);}finally{clearTimeout(timeout!);}};
  try{
    const registered=await registerUser({email:name+'@example.test',player_name:name,password:'cluster-fixture-password',verified:true});assert.ok(registered.ok);uid=registered.user.uid;profile=(await getUuidByName(name))!;
    const token=await issueAccessToken({userId:uid,clientId:await getSystemClientId(),selectedProfile:profile,scopes:[SCOPES.SERVER_JOIN]});
    const [a,b]=await Promise.all([worker(),worker()]);
    const join=()=>fetch(a.origin+'/api/yggdrasil/sessionserver/session/minecraft/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:token.jwt,selectedProfile:profile,serverId})});
    const check=(origin:string,query:Record<string,string>={})=>fetch(origin+'/api/yggdrasil/sessionserver/session/minecraft/hasJoined?'+new URLSearchParams({username:name,serverId,...query}));
    assert.equal((await join()).status,204);
    const stored=await queryOne<{payload:string}>('SELECT payload FROM mcn_oauth_flows WHERE token_hash=?',[joinSessionKey(serverId,profile)]);assert.ok(stored);assert.ok(!stored.payload.includes(token.jwt));assert.ok(!stored.payload.includes(name));
    assert.equal((await check(b.origin,{ip:'192.0.2.1'})).status,204);assert.equal((await check(b.origin,{serverId:'different'})).status,204);
    const joined=await check(b.origin);assert.equal(joined.status,200);const data:any=await joined.json();assert.equal(data.id,profile);assert.ok(data.properties[0].signature);
    await stop(a.child);const restarted=await worker();assert.equal((await check(restarted.origin)).status,200,'Join state outlives the issuing process');
    const tampered=JSON.parse(stored.payload);tampered.tag=crypto.randomBytes(16).toString('base64url');await exec('UPDATE mcn_oauth_flows SET payload=? WHERE token_hash=?',[JSON.stringify(tampered),joinSessionKey(serverId,profile)]);
    assert.equal((await check(b.origin)).status,204,'Tampered encrypted records fail closed');await exec('UPDATE mcn_oauth_flows SET payload=? WHERE token_hash=?',[stored.payload,joinSessionKey(serverId,profile)]);
    await exec('UPDATE mcn_oauth_flows SET expires_at=? WHERE token_hash=?',[nowString(-1),joinSessionKey(serverId,profile)]);assert.equal((await check(b.origin)).status,204);
    const again=await fetch(restarted.origin+'/api/yggdrasil/sessionserver/session/minecraft/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:token.jwt,selectedProfile:profile,serverId})});assert.equal(again.status,204);
    await revokeTokenRow(token.jti);assert.equal((await check(b.origin)).status,204);
  }finally{
    await Promise.all(workers.map(stop));
    if(profile)await exec('DELETE FROM mcn_oauth_flows WHERE token_hash=? AND stage=?',[joinSessionKey(serverId,profile),'ygg-join']);
    if(uid){await exec('DELETE FROM ygg_log WHERE user_id=?',[uid]);await exec('DELETE r FROM oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id=r.access_token_id WHERE a.user_id=?',[uid]);await exec('DELETE FROM oauth_access_tokens WHERE user_id=?',[uid]);await exec('DELETE FROM `uuid` WHERE name=?',[name]);await exec('DELETE FROM players WHERE uid=?',[uid]);await exec('DELETE FROM users WHERE uid=?',[uid]);}
    await pool.end();
  }
});
