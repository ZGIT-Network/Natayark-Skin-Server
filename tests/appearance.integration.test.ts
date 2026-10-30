import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, query, pool } from '../src/db.js';
import { registerUser } from '../src/services/user.js';
import { setSessionCookie } from '../src/services/session.js';
import { APPEARANCE_DEFAULTS } from '../src/services/theme.js';
import { getOption, loadOptions } from '../src/services/option.js';

test('admin appearance: validated persistence, homepage layouts and public isolation', { skip: !config.db.tablePrefix.startsWith('dev_') }, async t => {
  const app = await createApp();
  const keys = [...Object.keys(APPEARANCE_DEFAULTS), 'home_pic_url','fixed_bg','hide_intro','transparent_navbar'];
  const placeholders = keys.map(() => '?').join(',');
  const before = await query<{ id:number; option_name:string; option_value:string }>(`SELECT id,option_name,option_value FROM options WHERE option_name IN (${placeholders})`, keys);
  let uid = 0, name = 'Theme' + crypto.randomBytes(4).toString('hex'), cookie = '';
  try {
    const user = await registerUser({ email: name + '@example.test', player_name: name, verified: true });
    assert.ok(user.ok);
    uid = user.user.uid;
    await exec('UPDATE users SET permission=2 WHERE uid=?', [uid]);
    await setSessionCookie({ setCookie(key:string,value:string) { cookie = key + '=' + value; } } as any, uid);
    const settings = await app.inject({ url:'/admin/settings', headers:{cookie} });
    assert.equal(settings.statusCode, 200);
    assert.match(settings.body, /name="theme_primary"/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(settings.body)?.[1];
    assert.ok(csrf);
    const post = (extra:Record<string,string>, authenticated = true) => app.inject({ method:'POST', url:'/admin/settings', headers: authenticated ? {cookie} : {}, payload:{action:'appearance',csrf,...extra} });
    await t.test('unauthorized and invalid writes do not change colors', async () => {
      const old = await getOption('theme_primary');
      const anonymous = await post({theme_primary:'#ff0000'}, false);
      assert.notEqual(anonymous.headers.location, '/admin/settings?saved=1#appearance');
      const invalid = await post({theme_primary:'</style>',home_layout:'classic'});
      assert.match(String(invalid.headers.location), /appearance-invalid/);
      const invalidUrl = await post({theme_primary:'#ff0000',home_pic_url:'javascript:alert(1)'});
      assert.match(String(invalidUrl.headers.location), /appearance-invalid/);
      assert.equal(await getOption('theme_primary'), old);
    });
    await t.test('saved colors and layout render on subsequent public requests', async () => {
      const saved = await post({theme_primary:'#7847bf',theme_primary_dark:'#c9adff',theme_background:'#f7f3fc',theme_background_dark:'#1c1628',theme_default_mode:'system',home_layout:'minimal',home_show_recent:'false',home_pic_url:'/app/bg.webp'});
      assert.equal(saved.headers.location, '/admin/settings?saved=1#appearance');
      const page = await app.inject('/');
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /--primary:#7847bf/);
      assert.match(page.body, /--primary:#c9adff/);
      assert.match(page.body, /home-page home-minimal/);
      assert.doesNotMatch(page.body, /id="recent-title"/);
      assert.match(page.body, /prefers-color-scheme: dark/);
    });
    await t.test('all four previews work for admins and cannot override public layout', async () => {
      for (const layout of ['split','classic','gallery','minimal']) {
        const preview = await app.inject({url:'/?layout_preview=' + layout, headers:{cookie}});
        assert.equal(preview.statusCode, 200);
        assert.ok(preview.body.includes('home-page home-' + layout));
        assert.match(preview.body, /首页样式预览/);
      }
      const anonymous = await app.inject('/?layout_preview=classic');
      assert.match(anonymous.body, /home-page home-minimal/);
      assert.doesNotMatch(anonymous.body, /首页样式预览/);
      const reloaded = await app.inject({url:'/admin/settings',headers:{cookie}});
      assert.match(reloaded.body, /value="#7847bf"/);
      assert.match(reloaded.body, /value="minimal" checked/);
    });
  } finally {
    await exec(`DELETE FROM options WHERE option_name IN (${placeholders})`, keys);
    for (const row of before) await exec('INSERT INTO options (id,option_name,option_value) VALUES (?,?,?)', [row.id,row.option_name,row.option_value]);
    await loadOptions(true);
    if (uid) {
      await exec('DELETE FROM `uuid` WHERE name=?',[name]); await exec('DELETE FROM players WHERE uid=?',[uid]);
      await exec('DELETE FROM mcn_web_sessions WHERE user_id=?',[uid]); await exec('DELETE FROM users WHERE uid=?',[uid]);
    }
    await app.close(); await pool.end();
  }
});
