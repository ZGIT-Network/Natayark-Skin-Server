import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import Fastify from 'fastify';
import { config } from '../src/config.js';
import { exec, queryOne, insert, nowString, pool } from '../src/db.js';
import { issueAccessToken, getSystemClientId, revokeTokenRow, SCOPES } from '../src/services/token.js';
import { registerYggdrasilRoutes, yggdrasilMetadata } from '../src/routes/yggdrasil.js';
import { PRESENCE_TTL_MS } from '../src/services/friends.js';

test('Minecraft friends: role isolation, requests, privacy, presence, conditional polling and lifecycle',{skip:!config.db.tablePrefix.startsWith('dev_'),timeout:60000},async t=>{
  const migration=await fs.readFile(new URL('../migrations/004_minecraft_friends.sql',import.meta.url),'utf8');
  for(const sql of migration.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await exec(sql);
  const app=Fastify(),users:number[]=[],names:string[]=[],tokens:string[]=[];
  await registerYggdrasilRoutes(app);await app.ready();
  const suffix=crypto.randomBytes(4).toString('hex');
  const prefix='/api/yggdrasil/minecraftservices';
  const profiles:Array<{uid:number;pid:number;id:string;name:string;token:string;jti:string}>=[];
  const call=(index:number,method:'GET'|'POST'|'PUT',path:string,payload?:any,headers:Record<string,string>={})=>app.inject({method,url:prefix+path,headers:{authorization:'Bearer '+profiles[index].token,...headers},...(payload!==undefined?{payload}:{})});
  const update=(from:number,to:number,updateType='ADD')=>call(from,'PUT','/friends',{profileId:profiles[to].id,updateType});
  const prefs=(index:number,friends='ENABLED',acceptInvites='ENABLED')=>call(index,'POST','/player/attributes',{friendsPreferences:{friends,acceptInvites}});
  try{
    for(let i=0;i<4;i++){
      const uid=i===3?users[0]:await insert('INSERT INTO users (email,nickname,score,password,ip,last_sign_at,register_at,verified) VALUES (?,?,10000,?,?,?, ?,1)',[`friends-${suffix}-${i}@example.invalid`,'Friends fixture','fixture-hash','127.0.0.1',nowString(),nowString()]);
      if(i!==3)users.push(uid);
      const name='Friend'+suffix+i;names.push(name);
      const pid=await insert('INSERT INTO players (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,0,0,?)',[uid,name,nowString()]);
      const id=crypto.randomBytes(16).toString('hex');await exec('INSERT INTO `uuid` (name,uuid) VALUES (?,?)',[name,id]);
      const token=await issueAccessToken({userId:uid,clientId:await getSystemClientId(),selectedProfile:id,scopes:[SCOPES.PROFILE_SELECT,SCOPES.SERVER_JOIN]});tokens.push(token.jti);
      profiles.push({uid,pid,id,name,token:token.jwt,jti:token.jti});
    }
    await t.test('advertisement and both authlib-injector route forms',async()=>{
      assert.equal((await yggdrasilMetadata()).meta['feature.enable_mojang_anti_features'],true);
      for(const path of ['/friends','/presence','/player/attributes','/privileges','/privacy/blocklist']){
        const response=await app.inject({method:path==='/presence'?'POST':'GET',url:prefix+path,...(path==='/presence'?{payload:{status:'ONLINE'}}:{})});
        assert.equal(response.statusCode,401,path);assert.equal(response.json().path,path);assert.match(String(response.headers['cache-control']),/no-store/);
      }
      const response=await app.inject({url:'/minecraftservices/player/attributes',headers:{authorization:'Bearer '+profiles[0].token}});
      assert.equal(response.statusCode,200);assert.deepEqual(response.json().friendsPreferences,{friends:'ENABLED',acceptInvites:'ENABLED'});
      const scoped=await issueAccessToken({userId:users[0],clientId:await getSystemClientId(),selectedProfile:profiles[0].id,scopes:[SCOPES.PROFILE_SELECT]});tokens.push(scoped.jti);
      assert.equal((await app.inject({url:prefix+'/friends',headers:{authorization:'Bearer '+scoped.jwt}})).statusCode,403);
      const unbound=await issueAccessToken({userId:users[0],clientId:await getSystemClientId(),scopes:[SCOPES.SERVER_JOIN]});tokens.push(unbound.jti);
      assert.equal((await app.inject({url:prefix+'/friends',headers:{authorization:'Bearer '+unbound.jwt}})).statusCode,401);
    });
    await t.test('send, repeat, accept and remove; a second character on the same account stays isolated',async()=>{
      const sent=await call(0,'PUT','/friends',{name:profiles[1].name,updateType:'ADD'});assert.equal(sent.statusCode,200,sent.body);
      assert.deepEqual(sent.json().outgoingRequests,[{profileId:profiles[1].id,name:profiles[1].name}]);
      assert.equal((await update(0,1)).statusCode,200);
      assert.deepEqual((await call(1,'GET','/friends')).json().incomingRequests,[{profileId:profiles[0].id,name:profiles[0].name}]);
      assert.deepEqual((await call(3,'GET','/friends')).json(),{friends:[],incomingRequests:[],outgoingRequests:[]});
      assert.equal((await update(1,0)).statusCode,200);
      assert.equal((await call(0,'GET','/friends')).json().friends[0].profileId,profiles[1].id);
      assert.equal((await call(1,'GET','/friends')).json().friends[0].profileId,profiles[0].id);
      assert.equal((await update(0,1)).json().details.status,'ALREADY_FRIENDS');
      assert.equal((await update(0,1,'REMOVE')).statusCode,200);
      assert.equal((await call(1,'GET','/friends')).json().friends.length,0);
    });
    await t.test('decline and withdraw pending requests, including hyphenated UUIDs',async()=>{
      await update(0,1);await update(1,0,'REMOVE');assert.equal((await call(0,'GET','/friends')).json().outgoingRequests.length,0);
      const dashed=profiles[1].id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
      assert.equal((await call(0,'PUT','/friends',{profileId:dashed,updateType:'ADD'})).statusCode,200);
      await update(0,1,'REMOVE');assert.equal((await call(1,'GET','/friends')).json().incomingRequests.length,0);
    });
    await t.test('privacy changes persist independently and prevent new invitations',async()=>{
      assert.equal((await prefs(1,'ENABLED','DISABLED')).statusCode,200);
      const denied=await update(0,1);assert.equal(denied.statusCode,403);assert.equal(denied.json().details.status,'INVITE_REJECTED');
      assert.equal((await call(1,'GET','/player/attributes')).json().friendsPreferences.acceptInvites,'DISABLED');
      await prefs(1);await update(0,1);await prefs(1,'ENABLED','DISABLED');
      assert.equal((await update(1,0)).statusCode,200,'Existing incoming requests can still be accepted');
      await prefs(1,'DISABLED','DISABLED');
      assert.equal((await update(2,1)).statusCode,403);
      assert.deepEqual((await call(1,'POST','/presence',{status:'ONLINE'})).json(),{presence:[]});
      assert.equal((await call(3,'GET','/player/attributes')).json().friendsPreferences.friends,'ENABLED');
      await prefs(1);
      assert.equal((await call(1,'POST','/player/attributes',{profanityFilterPreferences:{profanityFilterOn:true}})).json().profanityFilterPreferences.profanityFilterOn,true);
      assert.equal((await call(1,'GET','/player/attributes')).json().friendsPreferences.friends,'ENABLED');
    });
    await t.test('presence is visible to accepted friends only, expires, and cannot be spoofed',async()=>{
      await call(1,'POST','/presence',{status:'PLAYING_SERVER',profileId:profiles[2].id});
      const online=await call(0,'POST','/presence',{status:'ONLINE'});assert.equal(online.statusCode,200,online.body);
      assert.equal(online.json().presence[0].profileId,profiles[1].id);assert.equal(online.json().presence[0].status,'PLAYING_SERVER');
      assert.ok(Number.isFinite(Date.parse(online.json().presence[0].lastUpdated)));
      assert.ok(!Object.hasOwn(online.json().presence[0],'pmid'),'Absent external PMID must be omitted, not serialized as null');
      assert.deepEqual((await call(2,'POST','/presence',{status:'ONLINE'})).json(),{presence:[]});
      await exec('UPDATE mcn_social_profiles SET last_seen=? WHERE profile_id=?',[Date.now()-PRESENCE_TTL_MS-1,profiles[1].id]);
      assert.equal((await call(0,'POST','/presence',{status:'ONLINE'})).json().presence[0].status,'OFFLINE');
      await call(1,'POST','/presence',{status:'ONLINE'});await prefs(1,'DISABLED');
      assert.equal((await call(0,'POST','/presence',{status:'ONLINE'})).json().presence[0].status,'OFFLINE');await prefs(1);
    });
    await t.test('conditional friends polling and presence heartbeats authenticate before returning 304',async()=>{
      const first=await call(0,'GET','/friends'),etag=String(first.headers.etag);assert.ok(etag);
      assert.equal((await call(0,'GET','/friends',undefined,{'if-none-match':etag})).statusCode,304);
      assert.equal((await call(2,'GET','/friends',undefined,{'if-none-match':etag})).statusCode,200,'ETag is based on this role\'s list');
      const poll=await call(0,'POST','/presence',{status:'ONLINE'});await exec('UPDATE mcn_social_profiles SET last_seen=1 WHERE profile_id=?',[profiles[0].id]);
      assert.equal((await call(0,'POST','/presence',{status:'PLAYING_OFFLINE'},{'if-none-match':String(poll.headers.etag)})).statusCode,304);
      assert.ok(Number((await queryOne<any>('SELECT last_seen FROM mcn_social_profiles WHERE profile_id=?',[profiles[0].id]))!.last_seen)>1);
      assert.equal((await app.inject({url:prefix+'/friends',headers:{authorization:'Bearer invalid','if-none-match':etag}})).statusCode,401);
    });
    await t.test('validation uses Minecraft Services errors and never trusts caller identity fields',async()=>{
      assert.equal((await update(0,0)).json().details.status,'CANNOT_ADD_SELF');
      assert.equal((await call(0,'PUT','/friends',{name:'unknown-'+suffix,updateType:'ADD'})).json().details.status,'UNKNOWN_PROFILE');
      for(const data of [{},{updateType:'ADD'},{profileId:'bad',updateType:'ADD'},{name:123,updateType:'ADD'},{name:profiles[1].name,updateType:'BLOCK'}])assert.equal((await call(0,'PUT','/friends',data)).statusCode,400);
      assert.equal((await call(0,'POST','/presence',{status:'JOINABLE'})).statusCode,400);
      assert.equal((await prefs(0,'YES')).statusCode,400);
      const invalid=await app.inject({method:'PUT',url:prefix+'/friends',headers:{authorization:'Bearer '+profiles[0].token,'content-type':'application/json'},payload:'{'});
      assert.equal(invalid.statusCode,400);assert.equal(invalid.json().details.status,'INVALID_JSON');
    });
    await t.test('mutual concurrent requests become one accepted relationship',async()=>{
      const results=await Promise.all([update(0,2),update(2,0)]);assert.ok(results.every(r=>r.statusCode===200),results.map(r=>r.body).join('\n'));
      assert.ok((await call(0,'GET','/friends')).json().friends.some((p:any)=>p.profileId===profiles[2].id));
      const row=await queryOne<{total:number}>('SELECT COUNT(*) AS total FROM mcn_friendships WHERE (profile_low=? AND profile_high=?) OR (profile_low=? AND profile_high=?)',[profiles[0].id,profiles[2].id,profiles[2].id,profiles[0].id]);assert.equal(Number(row!.total),1);
    });
    await t.test('replacing a character UUID does not inherit the previous social identity',async()=>{
      await update(3,0);await update(0,3);
      const previous=profiles[3].id,next=crypto.randomBytes(16).toString('hex');
      await exec('UPDATE `uuid` SET uuid=? WHERE name=?',[next,profiles[3].name]);
      assert.ok(!(await call(0,'GET','/friends')).json().friends.some((p:any)=>p.profileId===previous));
      assert.equal((await call(3,'GET','/friends')).statusCode,401,'An old selected-profile token is no longer valid');
      const issued=await issueAccessToken({userId:profiles[3].uid,clientId:await getSystemClientId(),selectedProfile:next,scopes:[SCOPES.PROFILE_SELECT,SCOPES.SERVER_JOIN]});tokens.push(issued.jti);
      Object.assign(profiles[3],{id:next,token:issued.jwt,jti:issued.jti});
      assert.deepEqual((await call(3,'GET','/friends')).json(),{friends:[],incomingRequests:[],outgoingRequests:[]});
      assert.equal(await queryOne('SELECT profile_id FROM mcn_social_profiles WHERE profile_id=?',[previous]),null);
    });
    await t.test('renames persist, revoked tokens go offline, and deletion removes social data',async()=>{
      const renamed=profiles[1].name+'R';names.push(renamed);
      await exec('UPDATE players SET name=? WHERE pid=?',[renamed,profiles[1].pid]);await exec('UPDATE `uuid` SET name=? WHERE uuid=?',[renamed,profiles[1].id]);
      assert.equal((await call(0,'GET','/friends')).json().friends.find((p:any)=>p.profileId===profiles[1].id).name,renamed);
      await call(1,'POST','/presence',{status:'ONLINE'});await revokeTokenRow(profiles[1].jti);
      assert.equal((await call(1,'GET','/friends')).statusCode,401);
      assert.equal((await call(0,'POST','/presence',{status:'ONLINE'})).json().presence.find((p:any)=>p.profileId===profiles[1].id).status,'OFFLINE');
      await exec('DELETE FROM players WHERE pid=?',[profiles[1].pid]);
      assert.equal(await queryOne('SELECT profile_id FROM mcn_social_profiles WHERE profile_id=?',[profiles[1].id]),null);
      assert.ok(!(await call(0,'GET','/friends')).json().friends.some((p:any)=>p.profileId===profiles[1].id));
      await exec('UPDATE users SET permission=-1 WHERE uid=?',[profiles[2].uid]);assert.equal((await call(2,'GET','/friends')).statusCode,401);
    });
  }finally{
    for(const jti of tokens){await exec('DELETE FROM oauth_refresh_tokens WHERE access_token_id=?',[jti]);await exec('DELETE FROM oauth_access_tokens WHERE id=?',[jti]);}
    for(const uid of users){await exec('DELETE FROM players WHERE uid=?',[uid]);await exec('DELETE FROM users WHERE uid=?',[uid]);}
    for(const name of names)await exec('DELETE FROM `uuid` WHERE name=?',[name]);
    await app.close();await pool.end();
  }
});
