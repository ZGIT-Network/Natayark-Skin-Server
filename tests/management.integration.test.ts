import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, query, queryOne, pool, nowString } from '../src/db.js';
import { registerUser } from '../src/services/user.js';
import { setSessionCookie, tokenHash } from '../src/services/session.js';
import { getOption, setOption, loadOptions } from '../src/services/option.js';
import { issueAccessToken, getSystemClientId } from '../src/services/token.js';
import { uploadTexture, deleteTexture, texturePath, getDescription, type Texture } from '../src/services/texture.js';

test('legacy management interfaces and finished account pages', {skip:!config.db.tablePrefix.startsWith('dev_')}, async t => {
  const app = await createApp(), suffix = crypto.randomBytes(4).toString('hex');
  const users:Array<{uid:number;name:string;email:string;cookie:string;csrf:string}>=[],textures:Texture[]=[];
  const keys=['copyright_text','textures_description_limit','require_verification'];
  const before=await query<any>(`SELECT * FROM options WHERE option_name IN (${keys.map(()=>'?')})`,keys);
  const account=async(label:string,permission=0)=>{
    const name=label+suffix,email=name+'@example.test';
    const result=await registerUser({email,player_name:name,password:'management-fixture-password',verified:true});
    assert.ok(result.ok);await exec('UPDATE users SET permission=?,score=10000 WHERE uid=?',[permission,result.user.uid]);
    let cookie='';await setSessionCookie({setCookie(key:string,value:string){cookie=key+'='+value;}} as any,result.user.uid);
    const page=await app.inject({url:'/user',headers:{cookie}});
    const csrf=/window\.__CSRF\s*=\s*"([^"]+)"/.exec(page.body)?.[1];assert.ok(csrf);
    const user={uid:result.user.uid,name,email,cookie,csrf};users.push(user);return user;
  };
  const image=async(uid:number,type:'steve'|'cape',isPublic=false)=>{
    const png=new PNG({width:64,height:type==='cape'?32:64});crypto.randomFillSync(png.data);
    for(let i=3;i<png.data.length;i+=4)png.data[i]=255;
    const result=await uploadTexture({uid,score:10000},{name:'Management '+type+' '+suffix,type,isPublic},{data:PNG.sync.write(png),name:'fixture.png'});
    assert.ok(result.ok&&!result.duplicate);textures.push(result.texture);return result.texture;
  };
  try {
    await setOption('require_verification','0');
    const admin=await account('Admin',2),reader=await account('Reader'),other=await account('Other');
    const skin=await image(reader.uid,'steve',true),cape=await image(reader.uid,'cape');
    const player=(await queryOne<any>('SELECT * FROM players WHERE uid=?',[reader.uid]))!;
    const write=(method:'POST'|'PUT'|'DELETE',url:string,body:object,user=admin)=>app.inject({method,url,headers:{cookie:user.cookie},payload:{csrf:user.csrf,...body}});
    await t.test('chart, status and legacy setting pages require an administrator',async()=>{
      assert.equal((await app.inject('/admin/chart')).statusCode,401);
      assert.equal((await app.inject({url:'/admin/chart',headers:{cookie:reader.cookie}})).statusCode,403);
      const chart=await app.inject({url:'/admin/chart',headers:{cookie:admin.cookie}});
      assert.equal(chart.statusCode,200);assert.equal(chart.json().xAxis.length,31);assert.equal(chart.json().data[0].length,31);assert.ok(chart.json().data[0].at(-1)>=3);
      for(const url of ['/admin','/admin/status','/admin/notifications','/admin/closet/'+reader.uid]){
        const page=await app.inject({url,headers:{cookie:admin.cookie}});assert.equal(page.statusCode,200,url);assert.match(page.body,/Powered by /);
      }
      const status=await app.inject({url:'/admin/status',headers:{cookie:admin.cookie}});
      const manifest=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
      assert.ok(status.body.includes('<code data-app-version>'+manifest.version+'</code>'));
      assert.match(status.body,/<button[^>]*data-check-updates[^>]*disabled/);
      assert.match(status.body,/更新检查尚未启用/);
      assert.equal((await app.inject({url:'/admin/score',headers:{cookie:admin.cookie}})).headers.location,'/admin/settings#score');
    });
    await t.test('role texture aliases validate type, CSRF, access scope and clear operations',async()=>{
      assert.equal((await write('PUT','/admin/players/'+player.pid+'/textures',{tid:skin.tid,type:'skin'},reader)).statusCode,403);
      assert.equal((await app.inject({method:'PUT',url:'/admin/players/'+player.pid+'/textures',headers:{cookie:admin.cookie},payload:{tid:skin.tid,type:'skin'}})).statusCode,403);
      assert.equal((await write('PUT','/admin/players/'+player.pid+'/textures',{tid:cape.tid,type:'skin'})).statusCode,422);
      const token=await issueAccessToken({userId:admin.uid,clientId:await getSystemClientId(),scopes:['PlayersManagement.ReadWrite']});
      assert.equal((await app.inject({method:'PUT',url:'/api/admin/players/'+player.pid+'/textures',headers:{authorization:'Bearer '+token.jwt},payload:{tid:skin.tid,type:'skin'}})).json().code,0);
      assert.equal((await queryOne<any>('SELECT tid_skin FROM players WHERE pid=?',[player.pid]))?.tid_skin,skin.tid);
      assert.equal((await write('PUT','/admin/players/'+player.pid+'/textures',{tid:0,type:'skin'})).json().code,0);
    });
    await t.test('admin closet aliases and old list pagination retain search and category',async()=>{
      assert.equal((await write('POST','/admin/closet/'+other.uid,{tid:skin.tid})).json().code,0);
      assert.equal((await write('POST','/admin/closet/'+other.uid,{tid:skin.tid})).statusCode,400);
      const closet=await app.inject({url:'/user/closet/list?category=cape&perPage=1',headers:{cookie:reader.cookie}});
      assert.equal(closet.json().per_page,1);assert.equal(closet.json().data[0].tid,cape.tid);
      const library=await app.inject({url:'/skinlib/list?filter=cape&uploader='+reader.uid,headers:{cookie:reader.cookie}});
      assert.equal(library.json().data.length,1);assert.equal(library.json().data[0].tid,cape.tid);
      const search=await app.inject({url:'/admin/users/list?q='+reader.email,headers:{cookie:admin.cookie}});
      assert.equal(search.json().total,1);assert.equal(search.json().data[0].uid,reader.uid);
      assert.equal((await write('DELETE','/admin/closet/'+other.uid,{tid:skin.tid})).json().code,0);
    });
    await t.test('admin advanced search supports grouped conditions, projection and sorting on legacy and HTML routes',async()=>{
      const expression=`(uid:${reader.uid} or uid:${other.uid}) score>=100 verified sort:-uid fields:uid,nickname`;
      const result=await app.inject({url:'/admin/users/list?q='+encodeURIComponent(expression),headers:{cookie:admin.cookie}});
      assert.equal(result.statusCode,200);assert.equal(result.json().total,2);assert.deepEqual(result.json().data.map((row:any)=>row.uid),[other.uid,reader.uid]);assert.deepEqual(Object.keys(result.json().data[0]),['uid','nickname']);
      const players=await app.inject({url:'/admin/players/list?q='+encodeURIComponent(`uid:${reader.uid} not skin:1 sort:pid`),headers:{cookie:admin.cookie}});assert.equal(players.statusCode,200);assert.equal(players.json().total,1);
      for(const entity of ['users','players','reports']){
        const page=await app.inject({url:'/admin/'+entity+'?keyword='+encodeURIComponent(entity==='users'?`uid:${reader.uid}`:entity==='players'?`uid:${reader.uid}`:'status:0'),headers:{cookie:admin.cookie}});assert.equal(page.statusCode,200);assert.match(page.body,/data-search-help/);
        const invalid=await app.inject({url:'/admin/'+entity+'?keyword='+encodeURIComponent('password:secret'),headers:{cookie:admin.cookie}});assert.equal(invalid.statusCode,422);assert.match(invalid.body,/role="alert"/);
      }
      const invalid=await app.inject({url:'/api/admin/users?q='+encodeURIComponent('sort:password'),headers:{cookie:admin.cookie}});assert.equal(invalid.statusCode,422);assert.equal(invalid.json().code,1);
      assert.equal((await app.inject({url:'/admin/users/list?q=score>0',headers:{cookie:reader.cookie}})).statusCode,403);
    });
    await t.test('legacy notification recipients, unread response, read body and owner isolation',async()=>{
      assert.equal((await write('POST','/api/admin/notifications',{receiver:'uid',uid:reader.uid,title:'Fixture notification',content:'**Markdown** <script>unsafe()</script>'})).json().sent,1);
      assert.equal((await write('POST','/admin/notifications/send',{receiver:'email',email:reader.email,title:'Email recipient',content:'Body'})).json().sent,1);
      assert.equal((await write('POST','/api/admin/notifications',{uid:2147483647,title:'Missing'})).statusCode,422);
      assert.equal((await write('POST','/api/admin/notifications',{receiver:'invalid',uid:reader.uid,title:'Invalid recipient'})).statusCode,422);
      const token=await issueAccessToken({userId:reader.uid,clientId:await getSystemClientId(),scopes:['Notification.Read']});
      const headers={authorization:'Bearer '+token.jwt};
      const list=await app.inject({url:'/api/user/notifications',headers});assert.equal(list.json().length,2);
      const id=list.json().find((item:any)=>item.title==='Fixture notification').id;
      assert.equal((await write('POST','/user/notifications/'+id,{},other)).statusCode,404);
      const read=await app.inject({method:'POST',url:'/api/user/notifications/'+id,headers});
      assert.equal(read.statusCode,200);assert.match(read.json().content,/<strong>Markdown<\/strong>/);assert.doesNotMatch(read.json().content,/<script/);
      assert.equal((await app.inject({url:'/api/user/notifications',headers})).json().length,1);
      assert.equal((await write('POST','/user/notifications/all',{},reader)).json().code,0);
    });
    await t.test('Markdown roundtrip keeps long descriptions, rejects configured limits and protects private raw content',async()=>{
      const text='## Author\n'+ '说明'.repeat(180)+'\n<script>alert(1)</script> [bad](javascript:alert(1))';
      await setOption('textures_description_limit','0');
      const updated=await write('PUT','/api/skinlib/'+skin.tid+'/description',{description:text},reader);
      assert.equal(updated.statusCode,200);assert.equal(await getDescription(skin.tid),text);
      assert.match(updated.json().html,/<h2>Author<\/h2>/);assert.doesNotMatch(updated.json().html,/<script|href="javascript/);
      assert.equal((await app.inject('/api/textures/'+skin.tid+'/description?raw')).body,text);
      assert.equal((await app.inject('/texture/'+cape.tid+'/description?raw')).statusCode,await getOption('status_code_for_private')==='404'?404:403);
      await setOption('textures_description_limit','10');
      assert.equal((await write('PUT','/texture/'+skin.tid+'/description',{description:'a'.repeat(11)},reader)).statusCode,422);
      assert.equal(await getDescription(skin.tid),text);
      assert.equal((await write('PUT','/texture/'+skin.tid+'/description',{description:'**OK**'},reader)).body,'<p><strong>OK</strong></p>\n');
    });
    await t.test('personal tokens render safely, restrict admin scopes, and revoke',async()=>{
      assert.equal((await write('POST','/oauth/personal-access-tokens',{scopes:['UsersManagement.ReadWrite']},reader)).statusCode,400);
      const created=await write('POST','/oauth/personal-access-tokens',{scopes:['User.Read']},reader);
      assert.equal(created.statusCode,200);assert.match(String(created.headers['cache-control']),/no-store/);
      const page=await app.inject({url:'/user/applications',headers:{cookie:reader.cookie}});
      assert.equal(page.statusCode,200);assert.match(page.body,/User.Read/);assert.ok(!page.body.includes(created.json().accessToken));
      assert.equal((await write('DELETE','/oauth/personal-access-tokens/'+created.json().token.id,{},reader)).json().code,0);
    });
    await t.test('empty custom footer has only project attribution and record pages render named fields',async()=>{
      const updated=await write('POST','/admin/options',{copyright_text:''});assert.equal(updated.statusCode,302);
      const page=await app.inject('/');assert.doesNotMatch(page.body,/Copyright ©|All rights reserved/);assert.match(page.body,/Powered by /);
      await exec('INSERT INTO reports (tid,uploader,reporter,reason,status,report_at) VALUES (?,?,?,?,0,?)',[skin.tid,reader.uid,other.uid,'Fixture report reason',nowString()]);
      for(const url of ['/user/notifications','/user/reports','/user/score-info','/user/closet']){
        const view=await app.inject({url,headers:{cookie:other.cookie}});assert.equal(view.statusCode,200,url);assert.doesNotMatch(view.body,/<th>notifiable_id|<th>report_at/);
      }
    });
    await t.test('legacy mailbox routes retain CSRF, owner binding and proof before update',async()=>{
      assert.equal((await app.inject('/auth/bind')).statusCode,302);
      assert.equal((await write('POST','/auth/bind',{email:'replacement@example.test'},reader)).statusCode,403);
      assert.equal((await app.inject({url:'/auth/verify/'+reader.uid,headers:{cookie:reader.cookie}})).statusCode,200);
      assert.equal((await app.inject({url:'/auth/verify/'+reader.uid+'?token=unknown',headers:{cookie:reader.cookie}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url:'/user/email-verification',headers:{cookie:reader.cookie},payload:{}})).statusCode,403);
      await exec('UPDATE users SET email=? WHERE uid=?',['',other.uid]);
      await exec('UPDATE users SET verified=0 WHERE uid=?',[other.uid]);await setOption('require_verification','1');
      const bind=await app.inject({url:'/auth/bind',headers:{cookie:other.cookie}});
      assert.equal(bind.statusCode,200);assert.match(bind.body,/name="email"/);
      assert.equal((await write('POST','/auth/bind',{email:'not-email'},other)).statusCode,400);
      assert.equal((await queryOne<any>('SELECT email FROM users WHERE uid=?',[other.uid]))?.email,'');
      const token=crypto.randomBytes(32).toString('base64url');
      await exec('UPDATE users SET verified=0 WHERE uid=?',[reader.uid]);
      await exec('INSERT INTO mcn_email_challenges (token_hash,purpose,user_id,payload,created_at,expires_at) VALUES (?,?,?,?,?,?)',[tokenHash(token),'verify',reader.uid,'{}',nowString(),nowString(3600)]);
      assert.equal((await app.inject('/auth/verify/'+other.uid+'?token='+token)).statusCode,400);
      assert.equal((await app.inject('/auth/verify/'+reader.uid+'?token='+token)).statusCode,302);
      assert.equal((await queryOne<any>('SELECT verified FROM users WHERE uid=?',[reader.uid]))?.verified,1);
      assert.equal((await app.inject('/auth/verify/'+reader.uid+'?token='+token)).statusCode,400);
    });
  } finally {
    await exec(`DELETE FROM options WHERE option_name IN (${keys.map(()=>'?')})`,keys);
    for(const row of before)await exec('INSERT INTO options (id,option_name,option_value) VALUES (?,?,?)',[row.id,row.option_name,row.option_value]);await loadOptions(true);
    for(const texture of textures){await deleteTexture(texture);await fs.unlink(texturePath(texture.hash)).catch(()=>{});}
    for(const user of users){
      await exec('DELETE FROM notifications WHERE notifiable_id=?',[user.uid]);await exec('DELETE FROM reports WHERE reporter=?',[user.uid]);
      await exec('DELETE FROM oauth_access_tokens WHERE user_id=?',[user.uid]);await exec('DELETE FROM user_closet WHERE user_uid=?',[user.uid]);
      await exec('DELETE FROM `uuid` WHERE name=?',[user.name]);await exec('DELETE FROM players WHERE uid=?',[user.uid]);
      await exec('DELETE FROM mcn_web_sessions WHERE user_id=?',[user.uid]);await exec('DELETE FROM users WHERE uid=?',[user.uid]);
      await exec('DELETE FROM mcn_email_challenges WHERE user_id=?',[user.uid]);
    }
    await app.close();await pool.end();
  }
});
