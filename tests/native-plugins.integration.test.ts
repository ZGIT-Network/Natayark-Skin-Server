import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {PNG} from 'pngjs';
import {createApp} from '../src/app.js';
import {config,parseTrustProxy} from '../src/config.js';
import {query,queryOne,exec,pool,withTransaction} from '../src/db.js';
import {getOption,setOption,loadOptions} from '../src/services/option.js';
import {registerUser} from '../src/services/user.js';
import {setSessionCookie} from '../src/services/session.js';
import {findPlayerByPid,setPlayerTexture,clearPlayerTexture,renamePlayer} from '../src/services/player.js';
import {batchImportTextures} from '../src/services/batch-import.js';
import {deleteTexture,texturePath} from '../src/services/texture.js';
import {signedCdnRefreshUrl} from '../src/services/integrations.js';
import {verifyCaptcha} from '../src/services/captcha.js';

test('original enabled native plugins: batch import, quote, menus, proxy and CDN callbacks',{skip:!config.db.tablePrefix.startsWith('dev_')},async t=>{
 const suffix=crypto.randomBytes(4).toString('hex'),name='Native'+suffix,email=name+'@example.test';
 const keys=['plugins_enabled','hitokoto_api','hitokoto_fallback','hitokoto_cache_seconds','recaptcha_sitekey','recaptcha_secretkey','recaptcha_verify_url','recaptcha_invisible'];
 const before=await query<any>(`SELECT * FROM options WHERE option_name IN (${keys.map(()=>'?')})`,keys);
 const savedProxy=config.trustProxy,envKeys=['ALICDN_SITE_BASE_URL','ALICDN_ACCESSKEY_ID','ALICDN_ACCESSKEY_SECRET','ALICDN_API_ENDPOINT'];
 const savedEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'natayark-compat-'));let uid=0,quoteCalls=0,quoteFail=false;
 const cdnCalls:URLSearchParams[]=[],textures:any[]=[];
 const server=http.createServer(async(request,response)=>{
  if(request.url==='/recaptcha'){
   let body='';for await(const chunk of request)body+=chunk;const form=new URLSearchParams(body);assert.equal(request.method,'POST');assert.equal(form.get('secret'),'fixture-secret');assert.equal(form.get('remoteip'),'198.51.100.1');
   response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({success:form.get('response')!=='invalid',hostname:form.get('response')==='wrong-host'?'wrong.example':new URL(config.publicOrigin||'http://localhost').hostname}));return;
  }
  if(request.url==='/quote'){quoteCalls++;response.writeHead(quoteFail?503:200,{'Content-Type':'text/plain'});response.end(quoteFail?'Unavailable':'本地验收一言');return;}
  if(request.url==='/cdn'){
   let body='';for await(const chunk of request)body+=chunk;
   assert.equal(request.method,'POST');cdnCalls.push(new URLSearchParams(body));
   response.writeHead(200,{'Content-Type':'application/json'});response.end('{"RefreshTaskId":"fixture"}');return;
  }
  response.writeHead(404);response.end();
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as net.AddressInfo).port;
 config.trustProxy=parseTrustProxy('loopback,192.0.2.0/24');
 const app=await createApp();app.get('/__native-test/ip',request=>({ip:request.ip}));
 try{
  for(const [key,value]of Object.entries({plugins_enabled:JSON.stringify(['single-player-limit','share-registration-link','gravatar','204-for-unexisted-players','hide-advanced-menu','hitokoto','refresh-ali-cdn','usm-api','legacy-api','yggdrasil-api'].map(name=>({name,version:'fixture'}))),hitokoto_api:base+'/quote',hitokoto_fallback:'备用一言',hitokoto_cache_seconds:'60'}))await setOption(key,value);
  const registered=await registerUser({email,player_name:name,password:'native-fixture-password',verified:true});assert.ok(registered.ok);uid=registered.user.uid;
  let cookie='';await setSessionCookie({setCookie(key:string,value:string){cookie=key+'='+value;}} as any,uid);
  const headers={cookie};
  await t.test('enabled menu and quote cache/fallback honor actual object-array settings',async()=>{
   const page=await app.inject({url:'/user',headers});assert.equal(page.statusCode,200);
   const sidebar=page.body.slice(page.body.indexOf('<aside class="sidebar"'),page.body.indexOf('</aside>'));
   assert.ok(!sidebar.includes('href="/user/applications"'));assert.match(page.body,/data-site-quote/);
   const quote=await app.inject({url:'/user/quote',headers});assert.equal(quote.json().text,'本地验收一言');assert.equal(quote.json().stale,false);
   await app.inject({url:'/user/quote',headers});assert.equal(quoteCalls,1);
   const now=Date.now;try{Date.now=()=>now()+61000;quoteFail=true;const stale=await app.inject({url:'/user/quote',headers});assert.equal(stale.json().text,'本地验收一言');assert.equal(stale.json().stale,true);}finally{Date.now=now;}
  });
  await t.test('trusted proxy ranges accept forwarded clients only from trusted peers',async()=>{
   const headers={'x-forwarded-for':'198.51.100.50'};
   assert.equal((await app.inject({url:'/__native-test/ip',remoteAddress:'127.0.0.1',headers})).json().ip,'198.51.100.50');
   assert.equal((await app.inject({url:'/__native-test/ip',remoteAddress:'203.0.113.20',headers})).json().ip,'203.0.113.20');
   assert.throws(()=>parseTrustProxy('0.0.0.0/99'));assert.equal(parseTrustProxy('false'),false);
  });
  await t.test('batch import accepts legacy trailing PNG bytes and preserves score/closet semantics',async()=>{
   const png=new PNG({width:64,height:64});for(let i=0;i<png.data.length;i+=4){png.data[i]=crypto.randomBytes(1)[0];png.data[i+1]=30;png.data[i+2]=90;png.data[i+3]=255;}
   await fs.writeFile(path.join(directory,'兼容材质.png'),Buffer.concat([PNG.sync.write(png),Buffer.from('legacy trailing metadata')]));
   const score=(await queryOne<any>('SELECT score FROM users WHERE uid=?',[uid]))!.score;
   const dry=await batchImportTextures({uploader:uid,directory});assert.equal(dry[0].status,'would-import');
   const imported=await batchImportTextures({uploader:uid,directory,dryRun:false});assert.equal(imported[0].status,'imported');
   textures.push((await queryOne('SELECT * FROM textures WHERE tid=?',[imported[0].tid]))!);
   assert.equal((await queryOne<any>('SELECT score FROM users WHERE uid=?',[uid]))?.score,score);
   assert.equal((await queryOne<any>('SELECT COUNT(*) AS count FROM user_closet WHERE user_uid=?',[uid]))?.count,0);
   assert.equal((await batchImportTextures({uploader:uid,directory,dryRun:false}))[0].status,'duplicate');
  });
  await t.test('reCAPTCHA checks tokens and hostnames; settings never expose its secret',async()=>{
   await setOption('recaptcha_secretkey','fixture-secret');await setOption('recaptcha_sitekey','fixture-site');await setOption('recaptcha_verify_url',base+'/recaptcha');
   assert.equal(await verifyCaptcha('fixture-sid','valid','198.51.100.1'),true);assert.equal(await verifyCaptcha('fixture-sid','invalid','198.51.100.1'),false);assert.equal(await verifyCaptcha('fixture-sid','wrong-host','198.51.100.1'),false);
   await setOption('recaptcha_verify_url',base+'/unavailable');assert.equal(await verifyCaptcha('fixture-sid','valid','198.51.100.1'),false);
   await exec('UPDATE users SET permission=2 WHERE uid=?',[uid]);const page=await app.inject({url:'/admin/settings',headers});assert.equal(page.statusCode,200);assert.doesNotMatch(page.body,/fixture-secret/);
   const csrf=/name="csrf" value="([^"]+)"/.exec(page.body)![1];
   const save=await app.inject({method:'POST',url:'/admin/settings',headers,payload:{csrf,recaptcha_sitekey:'fixture-site',recaptcha_secretkey:''}});assert.equal(save.statusCode,302);assert.equal(await getOption('recaptcha_secretkey'),'fixture-secret');
   const invisible=await app.inject({method:'POST',url:'/admin/settings',headers,payload:{csrf,recaptcha_sitekey:'fixture-site',recaptcha_secretkey:'',recaptcha_invisible:'true'}});assert.equal(invisible.statusCode,302);assert.equal(await getOption('recaptcha_invisible'),'true');
   const register=await app.inject('/auth/register');assert.match(register.body,/data-invisible="true"/);assert.match(register.body,/onload=natayarkCaptchaReady/);assert.ok(register.body.indexOf('src="/js/captcha.js"')<register.body.indexOf('src="https://www.recaptcha.net'));
   const checkbox=await app.inject({method:'POST',url:'/admin/settings',headers,payload:{csrf,recaptcha_sitekey:'fixture-site',recaptcha_secretkey:'',recaptcha_invisible:'false'}});assert.equal(checkbox.statusCode,302);assert.match((await app.inject('/auth/register')).body,/data-invisible="false"/);
   await setOption('recaptcha_secretkey','');await setOption('recaptcha_sitekey','');
  });
  await t.test('CDN signing matches independent PHP vectors for GET and POST',async()=>{
   const fixture=JSON.parse(await fs.readFile('tests/fixtures/cdn-signature.json','utf8'));
   for(const method of ['GET','POST'])assert.equal(new URL(signedCdnRefreshUrl(base+'/cdn',fixture.params,fixture.secret,method)).searchParams.get('Signature'),fixture.signatures[method]);
  });
  await t.test('committed role changes purge profile URLs; rollback emits no purge',async()=>{
   process.env.ALICDN_SITE_BASE_URL='https://fixture.example';process.env.ALICDN_ACCESSKEY_ID='fixture-key';process.env.ALICDN_ACCESSKEY_SECRET='fixture-secret';process.env.ALICDN_API_ENDPOINT=base+'/cdn';
   const player=(await queryOne<any>('SELECT * FROM players WHERE uid=?',[uid]))!;
   await setPlayerTexture(player,'skin',textures[0].tid);
   assert.equal(cdnCalls.length,1);const first=cdnCalls[0];assert.ok(first.get('Signature'));assert.equal(first.get('ObjectType'),'File');
   const paths=first.get('ObjectPath')!.split('\n');assert.ok(paths.includes('https://fixture.example/csl/'+name+'.json'));assert.ok(paths.some(value=>value.includes('/sessionserver/session/minecraft/profile/')));
   const count=cdnCalls.length;await assert.rejects(withTransaction(async()=>{await clearPlayerTexture(player,'skin');throw new Error('rollback fixture');}));assert.equal(cdnCalls.length,count);
   assert.equal((await findPlayerByPid(player.pid))?.tid_skin,textures[0].tid);
   const originalUuid=(await queryOne<any>('SELECT uuid FROM `uuid` WHERE name=?',[name]))!.uuid;
   await renamePlayer(player,'Renamed'+suffix);assert.equal(cdnCalls.length,count+1);assert.ok(cdnCalls.at(-1)!.get('ObjectPath')!.includes('/csl/'+name+'.json'));assert.ok(cdnCalls.at(-1)!.get('ObjectPath')!.includes('/csl/Renamed'+suffix+'.json'));
   const newUuid=(await queryOne<any>('SELECT uuid FROM `uuid` WHERE name=?',['Renamed'+suffix]))!.uuid,pathsAfterRename=cdnCalls.at(-1)!.get('ObjectPath')!;
   assert.ok(pathsAfterRename.includes('/profile/'+originalUuid));assert.ok(pathsAfterRename.includes('/profile/'+newUuid));
  });
 }finally{
  for(const key of envKeys){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}
  for(const texture of textures){await deleteTexture(texture);await fs.unlink(texturePath(texture.hash)).catch(()=>{});}
  if(uid){await exec('DELETE FROM user_closet WHERE user_uid=?',[uid]);await exec('DELETE FROM `uuid` WHERE name IN (?,?)',[name,'Renamed'+suffix]);await exec('DELETE FROM players WHERE uid=?',[uid]);await exec('DELETE FROM mcn_web_sessions WHERE user_id=?',[uid]);await exec('DELETE FROM users WHERE uid=?',[uid]);}
  await exec(`DELETE FROM options WHERE option_name IN (${keys.map(()=>'?')})`,keys);for(const row of before)await exec('INSERT INTO options (id,option_name,option_value) VALUES (?,?,?)',[row.id,row.option_name,row.option_value]);await loadOptions(true);
  config.trustProxy=savedProxy;await app.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();
  const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('natayark-compat-'));await fs.rm(resolved,{recursive:true});
 }
});
