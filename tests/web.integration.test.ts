import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, queryOne, pool } from '../src/db.js';
import { registerUser } from '../src/services/user.js';
import { setSessionCookie } from '../src/services/session.js';
import { closetAdd, deleteTexture, uploadTexture, texturePath, type Texture } from '../src/services/texture.js';
import { getOptionInt } from '../src/services/option.js';
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
      assert.match(page.body, /上传奖励（公开 \/ 私有）/);
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
