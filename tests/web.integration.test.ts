import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, queryOne, pool,insert,nowString } from '../src/db.js';
import {listPlayersOfUser,setPlayerTexture,clearPlayerTexture} from '../src/services/player.js';
import { registerUser } from '../src/services/user.js';
import { setSessionCookie } from '../src/services/session.js';
import { closetAdd, deleteTexture, uploadTexture, texturePath, type Texture } from '../src/services/texture.js';
import { getOptionInt,getOption,setOption } from '../src/services/option.js';
import sharp from 'sharp';
import { getUuidByName, maskUuid } from '../src/services/uuid.js';

test('texture pages: upload pricing, closet prerequisite, applied state and error pages', { skip: !config.db.tablePrefix.startsWith('dev_') }, async t => {
  const app = await createApp();
  const users: Array<{ uid: number; name: string }> = [];
  const textures: Texture[] = [];
  const suffix = crypto.randomBytes(4).toString('hex');
  async function user(label: string) {
    const name = label + suffix;
    const result = await registerUser({ email: name + '@example.test', player_name: name, verified: true });
    assert.ok(result.ok, JSON.stringify(result));
    const uid = result.user.uid;
    users.push({ uid, name });
    await exec('UPDATE users SET score=10000 WHERE uid=?', [uid]);
    let cookie = '';
    await setSessionCookie({ setCookie(key: string, value: string) { cookie = key + '=' + value; } } as any, uid);
    return { uid, name, cookie };
  }
  async function texture(uid: number, isPublic: boolean, type: 'steve' | 'cape' = 'steve') {
    const png = new PNG({ width: 64, height: type === 'cape' ? 32 : 64 });
    crypto.randomFillSync(png.data);
    const result = await uploadTexture({ uid, score: 10000 }, { name: 'Web' + suffix, type, isPublic }, { data: PNG.sync.write(png), name: 'web-fixture' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.duplicate, false);
    textures.push(result.texture);
    return result.texture;
  }
  try {
    const owner = await user('Owner'), viewer = await user('Viewer');
    const publicTexture = await texture(owner.uid, true), privateTexture = await texture(owner.uid, false);
    await t.test('root favicon is a static asset rather than a legacy player name',async()=>{
      const favicon=await app.inject('/favicon.ico');assert.equal(favicon.statusCode,200);assert.match(String(favicon.headers['content-type']),/^image\//);
    });
    await t.test('dashboard usage includes owned public and private uploads without exposing another account',async()=>{
      const usage=await app.inject({url:'/user/usage',headers:{cookie:owner.cookie}});
      assert.equal(usage.statusCode,200);assert.match(String(usage.headers['cache-control']),/no-store/);
      assert.equal(usage.json().storage.used,publicTexture.size+privateTexture.size);
      assert.equal(usage.json().players.used,1);
      assert.equal((await app.inject('/user/usage')).statusCode,401);
      assert.equal((await app.inject({url:'/user/usage?uid='+owner.uid,headers:{cookie:viewer.cookie}})).json().storage.used,0);
      const dashboard=await app.inject({url:'/user',headers:{cookie:owner.cookie}});
      assert.equal(dashboard.statusCode,200);assert.match(dashboard.body,/data-account-usage/);assert.match(dashboard.body,/data-usage-progress="storage"/);
    });
    await t.test('language choice persists for accounts and guests across pages and old URLs',async()=>{
      const account=await user('Locale');
      const first=await app.inject({url:'/user/closet?keyword=Green&sort=time',headers:{cookie:account.cookie}});
      const csrf=/<meta name="csrf-token" content="([^"]+)"/.exec(first.body)![1];
      const choose=(locale:string,extra:Record<string,string>={})=>app.inject({method:'POST',url:'/locale',headers:{cookie:account.cookie,accept:'application/json'},payload:{csrf,locale,redirect:'/user/closet?keyword=Green&sort=time&lang=zh_CN#library',...extra}});
      const saved=await choose('en');assert.equal(saved.statusCode,200);assert.deepEqual(saved.json(),{code:0,locale:'en',redirect:'/user/closet?keyword=Green&sort=time#library'});
      assert.equal((await queryOne<any>('SELECT locale FROM users WHERE uid=?',[account.uid]))!.locale,'en');
      assert.match(String(saved.headers['set-cookie']),/mcnskin_locale=en;.*Max-Age=31536000/);
      for(const url of ['/user','/user/player','/user/profile','/user/verification','/user/closet?lang=zh_CN','/']){
        const page=await app.inject({url,headers:{cookie:account.cookie}});assert.equal(page.statusCode,200,url);assert.match(page.body,/<html lang="en"/,url);
        assert.match(page.body,/<button[^>]*value="en"[^>]*aria-checked="true"/,url);
      }
      assert.equal((await choose('en',{csrf:'invalid'})).statusCode,403);
      assert.equal((await choose('invalid')).statusCode,422);
      assert.equal((await choose('en',{redirect:'//example.com/'})).json().redirect,'/');
      const back=await app.inject({method:'POST',url:'/locale',headers:{cookie:account.cookie},payload:{csrf,locale:'zh_CN',redirect:'/user/profile?lang=en'}});
      assert.equal(back.statusCode,303);assert.equal(back.headers.location,'/user/profile');
      const profile=await app.inject({method:'POST',url:'/user/profile',headers:{cookie:account.cookie},payload:{csrf,action:'locale',locale:'en'}});
      assert.equal(profile.statusCode,302);assert.match(String(profile.headers['set-cookie']),/mcnskin_locale=en/);
      const landing=await app.inject('/');
      const guestCookies=landing.cookies.map(cookie=>cookie.name+'='+cookie.value).join('; ');
      const guestCsrf=/<meta name="csrf-token" content="([^"]+)"/.exec(landing.body)![1];
      const guestSaved=await app.inject({method:'POST',url:'/locale',headers:{cookie:guestCookies,accept:'application/json'},payload:{csrf:guestCsrf,locale:'en',redirect:'/'}});
      assert.equal(guestSaved.statusCode,200);
      const languageCookie=guestSaved.cookies.find(cookie=>cookie.name==='mcnskin_locale');assert.ok(languageCookie);
      const guestHeaders={cookie:guestCookies+'; '+languageCookie.name+'='+languageCookie.value};
      for(const url of ['/','/skinlib','/auth/login','/?lang=zh_CN'])assert.match((await app.inject({url,headers:guestHeaders})).body,/<html lang="en"/,url);
      // A stored account choice takes precedence over another browser's guest preference.
      assert.match((await app.inject({url:'/user',headers:{cookie:account.cookie+'; mcnskin_locale=zh_CN'}})).body,/<html lang="en"/);
    });
    await t.test('dashboard provides launcher setup and an accurate Minecraft verification guide',async()=>{
      const account=await user('Guide'),oldKey=process.env.MICROSOFT_KEY,oldSecret=process.env.MICROSOFT_SECRET;
      const reward=await getOption('mojang_verification_score_award','0'),uuid=crypto.randomBytes(16).toString('hex');
      const dashboard=()=>app.inject({url:'/user',headers:{cookie:account.cookie}});
      try{
        process.env.MICROSOFT_KEY='dashboard-fixture-client';process.env.MICROSOFT_SECRET='dashboard-fixture-secret';
        await setOption('mojang_verification_score_award','137');
        const unverified=await dashboard();assert.equal(unverified.statusCode,200);
        assert.match(unverified.body,/draggable="true"[^>]*data-launcher-drag="https?:\/\/[^\"]+\/api\/yggdrasil"/);
        assert.match(unverified.body,/将此按钮拖入启动器/);assert.match(unverified.body,/data-verification-status="unverified"/);
        assert.match(unverified.body,/首次完成验证可获得 137 积分/);assert.match(unverified.body,/href="\/user\/verification"/);
        await exec('INSERT INTO mojang_verifications (user_id,uuid,verified,created_at,updated_at) VALUES (?,?,1,?,?)',[account.uid,uuid,nowString(),nowString()]);
        const verified=await dashboard();assert.equal(verified.statusCode,200);assert.match(verified.body,/data-verification-status="verified"/);
        assert.match(verified.body,/查看验证信息/);assert.ok(!verified.body.includes('data-verification-reward'));assert.ok(!verified.body.includes(uuid));
        await exec('DELETE FROM mojang_verifications WHERE user_id=?',[account.uid]);process.env.MICROSOFT_KEY='';
        const unavailable=await dashboard();assert.match(unavailable.body,/data-verification-status="unavailable"/);
        assert.match(unavailable.body,/查看验证说明/);assert.ok(!unavailable.body.includes('data-verification-reward'));
      }finally{
        await exec('DELETE FROM mojang_verifications WHERE user_id=?',[account.uid]);await setOption('mojang_verification_score_award',reward);
        if(oldKey===undefined)delete process.env.MICROSOFT_KEY;else process.env.MICROSOFT_KEY=oldKey;
        if(oldSecret===undefined)delete process.env.MICROSOFT_SECRET;else process.env.MICROSOFT_SECRET=oldSecret;
      }
    });
    await t.test('account avatar follows equipped skins, revalidates changes and respects manual choice',async()=>{
      const account=await user('Avatar'),[first]=await listPlayersOfUser(account.uid);
      const skinA=await texture(account.uid,true),skinB=await texture(account.uid,false);
      const url='/avatar/user/'+account.uid+'?png&size=64';
      const baseline=await app.inject(url);
      const expectedA=await app.inject('/avatar/'+skinA.tid+'?png&size=64');
      const expectedB=await app.inject('/avatar/'+skinB.tid+'?png&size=64');
      await setPlayerTexture(first,'skin',skinA.tid);
      const initial=await app.inject(url);
      assert.equal(initial.statusCode,200);assert.deepEqual(initial.rawPayload,expectedA.rawPayload);
      assert.equal(initial.headers['cache-control'],'public, no-cache, max-age=0, must-revalidate');
      assert.equal((await app.inject({url,headers:{'if-none-match':String(initial.headers.etag)}})).statusCode,304);
      await setPlayerTexture(first,'skin',skinB.tid);
      const changed=await app.inject({url,headers:{'if-none-match':String(initial.headers.etag)}});
      assert.equal(changed.statusCode,200);assert.notEqual(changed.headers.etag,initial.headers.etag);
      assert.deepEqual(changed.rawPayload,expectedB.rawPayload);
      const profile=await app.inject({url:'/user/profile',headers:{cookie:account.cookie}});
      assert.match(profile.body,/v=5&amp;size=64|v=5&size=64/);
      assert.match(profile.body,/0 表示自动跟随角色皮肤/);
      const csrf=/<meta name="csrf-token" content="([^"]+)"/.exec(profile.body)![1];
      const setAvatar=(avatar:number)=>app.inject({method:'POST',url:'/user/profile',headers:{cookie:account.cookie},payload:{csrf,action:'avatar',avatar:String(avatar)}});
      assert.equal((await setAvatar(skinA.tid)).statusCode,302);
      assert.deepEqual((await app.inject(url)).rawPayload,expectedA.rawPayload);
      assert.equal((await setAvatar(0)).statusCode,302);
      assert.deepEqual((await app.inject(url)).rawPayload,expectedB.rawPayload);
      // Simulate a migrated account with several existing roles, independently of site role limits.
      const extra=await insert('INSERT INTO players (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,?,0,?)',[account.uid,'Extra'+suffix,skinA.tid,nowString()]);
      assert.deepEqual((await app.inject(url)).rawPayload,expectedB.rawPayload);
      await clearPlayerTexture(first,'skin');
      assert.deepEqual((await app.inject(url)).rawPayload,expectedA.rawPayload);
      await exec('UPDATE players SET tid_skin=? WHERE pid=?',[2147483647,first.pid]);
      assert.deepEqual((await app.inject(url)).rawPayload,expectedA.rawPayload);
      await setPlayerTexture(first,'skin',skinB.tid);
      const file=texturePath(skinB.hash);await fs.rename(file,file+'.avatar-test');
      try{assert.deepEqual((await app.inject(url)).rawPayload,expectedA.rawPayload);}finally{await fs.rename(file+'.avatar-test',file);}
      await exec('UPDATE players SET tid_skin=0 WHERE uid=?',[account.uid]);
      const fallback=await app.inject(url);assert.equal(fallback.statusCode,baseline.statusCode);
      if(baseline.statusCode===302)assert.equal(fallback.headers.location,baseline.headers.location);
      else assert.deepEqual(fallback.rawPayload,baseline.rawPayload);
      await exec('DELETE FROM players WHERE pid=?',[extra]);
      assert.equal((await app.inject('/avatar/user/invalid?png')).statusCode,200);
    });
    const detail = () => app.inject({ url: '/skinlib/show/' + publicTexture.tid, headers: { cookie: viewer.cookie } });
    const applyButton = (html: string) => {
      const button = /<button[^>]*data-action="apply-texture"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0];
      assert.ok(button, 'Viewer player has an apply button');
      return button;
    };
    await t.test('upload page uses the same normalized prices as settlement', async () => {
      const page = await app.inject({ url: '/skinlib/upload', headers: { cookie: viewer.cookie } });
      assert.equal(page.statusCode, 200);
      for (const [attribute, option, fallback] of [
        ['public-storage', 'score_per_storage', 3], ['private-storage', 'private_score_per_storage', 25],
        ['closet-cost', 'score_per_closet_item', 2], ['upload-award', 'score_award_per_texture', 0],
      ] as const) assert.ok(page.body.includes(`data-${attribute}="${await getOptionInt(option, fallback)}"`));
      assert.match(page.body, /首次内容上传奖励/);
      assert.match(page.body, /持有材质链接的人仍可读取图片/);
    });
    await t.test('uncollected texture is disabled with a visible instruction', async () => {
      const page = await detail();
      assert.equal(page.statusCode, 200);
      assert.match(applyButton(page.body), /\sdisabled(?:\s|>)/);
      assert.match(page.body, /请先点击「收藏到衣柜」/);
    });
    await t.test('collect then apply persists the material and the rendered applied state', async () => {
      assert.ok((await closetAdd(viewer.uid, publicTexture.tid, publicTexture.name)).ok);
      const page = await detail();
      assert.doesNotMatch(applyButton(page.body), /\sdisabled(?:\s|>)/);
      const csrf = /window\.__CSRF\s*=\s*"([^"]+)"/.exec(page.body)?.[1];
      assert.ok(csrf);
      const player = await queryOne<{ pid: number }>('SELECT pid FROM players WHERE uid=?', [viewer.uid]);
      assert.ok(player);
      const applied = await app.inject({ method: 'PUT', url: `/api/player/${player.pid}/textures`, headers: { cookie: viewer.cookie }, payload: { csrf, skin: publicTexture.tid } });
      assert.equal(applied.statusCode, 200, applied.body);
      assert.equal((await queryOne<{ tid_skin: number }>('SELECT tid_skin FROM players WHERE pid=?', [player.pid]))?.tid_skin, publicTexture.tid);
      const refreshed = await detail();
      assert.match(applyButton(refreshed.body), /已应用/);
      assert.match(applyButton(refreshed.body), /\sdisabled(?:\s|>)/);
    });
    await t.test('cape preview cache separates requested heights and preserves validators', async () => {
      const cape = await texture(owner.uid, true, 'cape');
      for (const height of [96,192,96]) {
        const page = await app.inject(`/preview/${cape.tid}?height=${height}&png`);
        assert.equal(page.statusCode, 200);
        assert.equal(PNG.sync.read(page.rawPayload).height, height + 40);
        const cached = await app.inject({ url:`/preview/${cape.tid}?height=${height}&png`, headers:{'if-none-match':String(page.headers.etag)} });
        assert.equal(cached.statusCode, 304);
      }
      const webp = await app.inject(`/preview/${cape.tid}?height=96`);
      assert.match(String(webp.headers['content-type']), /image\/webp/);
      const info = await sharp(webp.rawPayload).metadata();
      assert.equal(info.height, 136);
      const png = await app.inject(`/preview/${cape.tid}?height=96&png`);
      assert.match(String(png.headers['content-type']), /image\/png/);
      assert.notEqual(webp.headers.etag, png.headers.etag);
    });
    await t.test('public and admin galleries share bounded previews and preserve material access filters', async () => {
      const path = `/skinlib?keyword=Web${suffix}&uploader=${owner.uid}&type=steve&sort=likes`;
      const ids = (html: string) => [...html.matchAll(/data-texture-id="(\d+)"/g)].map(match => Number(match[1])).sort((a,b) => a-b);
      const publicPage = await app.inject(path);
      assert.equal(publicPage.statusCode, 200);
      assert.deepEqual(ids(publicPage.body), [publicTexture.tid]);
      assert.match(publicPage.body, /class="library-grid"/);
      assert.match(publicPage.body, /class="library-preview"/);
      assert.doesNotMatch(publicPage.body, /<table/);
      const ownPage = await app.inject({url:path,headers:{cookie:owner.cookie}});
      assert.deepEqual(ids(ownPage.body), [publicTexture.tid,privateTexture.tid].sort((a,b)=>a-b));
      const othersPrivate = await app.inject({url:path+'&status=private',headers:{cookie:viewer.cookie}});
      assert.deepEqual(ids(othersPrivate.body), []);
      await exec('UPDATE users SET permission=2 WHERE uid=?',[owner.uid]);
      const adminPage = await app.inject({url:path.replace('/skinlib','/admin/textures'),headers:{cookie:owner.cookie}});
      assert.equal(adminPage.statusCode,200);
      assert.deepEqual(ids(adminPage.body),ids(ownPage.body));
      assert.match(adminPage.body,/data-action="admin-delete-texture"/);
      assert.doesNotMatch(adminPage.body,/<table/);
    });
    await t.test('UUIDs are absent or masked in HTML and full details require the owning account', async () => {
      const player = await queryOne<{pid:number,name:string}>('SELECT pid,name FROM players WHERE uid=?',[owner.uid]);
      assert.ok(player);
      const uuid = await getUuidByName(player.name);
      assert.ok(uuid);
      const dashboard = await app.inject({url:'/user',headers:{cookie:owner.cookie}});
      const players = await app.inject({url:'/user/player',headers:{cookie:owner.cookie}});
      assert.ok(!dashboard.body.includes(uuid));
      assert.ok(!players.body.includes(uuid));
      assert.ok(players.body.includes(maskUuid(uuid)));
      assert.match(String(dashboard.headers['cache-control']),/private, no-store/);
      const url = '/user/privacy/uuid?player='+player.pid;
      assert.equal((await app.inject(url)).statusCode,401);
      assert.equal((await app.inject({url,headers:{cookie:viewer.cookie}})).statusCode,404);
      const own = await app.inject({url,headers:{cookie:owner.cookie}});
      assert.equal(own.json().uuid,uuid);
      assert.match(String(own.headers['cache-control']),/no-store/);
      const verifiedUuid = crypto.randomBytes(16).toString('hex');
      const viewerUuid = await getUuidByName(viewer.name);
      try {
        await exec('INSERT INTO mojang_verifications (user_id,uuid,verified) VALUES (?,?,1)',[owner.uid,verifiedUuid]);
        // A legacy duplicate mapping must not disclose another user's local character.
        await exec('UPDATE `uuid` SET uuid=? WHERE name=?',[verifiedUuid,viewer.name]);
        const verified = await app.inject({url:'/user/verification',headers:{cookie:owner.cookie}});
        assert.equal(verified.statusCode,200);
        assert.ok(!verified.body.includes(verifiedUuid));
        assert.ok(verified.body.includes(maskUuid(verifiedUuid)));
        assert.ok(!verified.body.includes(viewer.name));
        const reveal = await app.inject({url:'/user/privacy/uuid?source=mojang',headers:{cookie:owner.cookie}});
        assert.equal(reveal.json().uuid,verifiedUuid);
        const other = await app.inject({url:'/user/privacy/uuid?source=mojang&user_id='+owner.uid,headers:{cookie:viewer.cookie}});
        assert.equal(other.statusCode,404);
      } finally {
        await exec('UPDATE `uuid` SET uuid=? WHERE name=?',[viewerUuid,viewer.name]);
        await exec('DELETE FROM mojang_verifications WHERE user_id=?',[owner.uid]);
      }
    });
    await t.test('legacy Janus discovery paths resolve inside this app', async () => {
      assert.equal((await app.inject('/jwks')).statusCode,200);
      const token=await app.inject({method:'POST',url:'/token',payload:{grant_type:'unsupported'}});
      assert.equal(token.statusCode,400);
      assert.equal(token.json().error,'unsupported_grant_type');
      const authorize=await app.inject('/auth?client_id=not-a-client');
      assert.equal(authorize.statusCode,400);
      assert.equal(authorize.json().error,'invalid_client');
      assert.equal((await app.inject({method:'POST',url:'/device/auth',payload:{}})).statusCode,400);
      const cors=await app.inject({method:'OPTIONS',url:'/userinfo',headers:{origin:'https://launcher.example'}});
      assert.equal(cors.statusCode,204);
      assert.equal(cors.headers['access-control-allow-origin'],'*');
    });
    await t.test('missing and private texture errors retain the site template context', async () => {
      for (const [url, expected, message] of [
        ['/skinlib/show/2147483647', 404, '材质不存在'],
        ['/skinlib/show/' + privateTexture.tid, await getOptionInt('status_code_for_private', 403), '该材质为私有材质'],
      ] as const) {
        const page = await app.inject({ url, headers: { cookie: viewer.cookie } });
        assert.equal(page.statusCode, expected);
        assert.match(page.body, new RegExp(message));
        assert.match(page.body, /<html/);
        assert.match(page.body, /csrf-token/);
      }
    });
  } finally {
    for (const texture of textures) {
      await deleteTexture(texture);
      // These random files were created exclusively by this suite.
      await fs.unlink(texturePath(texture.hash));
    }
    for (const user of users) {
      await exec('DELETE FROM user_closet WHERE user_uid=?', [user.uid]);
      await exec('DELETE FROM `uuid` WHERE name=?', [user.name]);
      await exec('DELETE FROM players WHERE uid=?', [user.uid]);
      await exec('DELETE FROM mcn_web_sessions WHERE user_id=?', [user.uid]);
      await exec('DELETE FROM users WHERE uid=?', [user.uid]);
    }
    await app.close();
    await pool.end();
  }
});
