import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, query, pool, nowString } from '../src/db.js';
import { registerUser } from '../src/services/user.js';
import { setSessionCookie } from '../src/services/session.js';
import { getOption, loadOptions, setOption } from '../src/services/option.js';
import { loadPlayerNameRules } from '../src/util.js';

test('personalization settings persist and reach localized public pages', { skip: !config.db.tablePrefix.startsWith('dev_') }, async t => {
  const app = await createApp();
  const keys = [
    'announcement', 'announcement_zh_CN', 'announcement_en',
    'site_name', 'site_name_zh_CN', 'site_name_en',
    'site_description', 'site_description_zh_CN', 'site_description_en',
    'home_layout', 'local_login_enabled', 'ygg_connect_server_url',
    'player_name_rule', 'custom_player_name_regexp', 'player_name_length_min', 'player_name_length_max',
    'plugins_enabled', 'max_players_per_user', 'score_per_player',
    'sign_after_zero', 'sign_gap_time',
  ];
  const placeholders = keys.map(() => '?').join(',');
  const before = await query<{ id: number; option_name: string; option_value: string }>(
    `SELECT id,option_name,option_value FROM options WHERE option_name IN (${placeholders})`, keys,
  );
  const name = 'Setting' + crypto.randomBytes(4).toString('hex');
  let uid = 0, cookie = '';
  try {
    await setOption('local_login_enabled', 'true');
    const user = await registerUser({ email: name + '@example.test', nickname: name, player_name: name, verified: true });
    assert.ok(user.ok);
    uid = user.user.uid;
    await exec('UPDATE users SET permission=2 WHERE uid=?', [uid]);
    await setSessionCookie({ setCookie(key: string, value: string) { cookie = key + '=' + value; } } as any, uid);
    const settings = await app.inject({ url: '/admin/settings', headers: { cookie } });
    assert.equal(settings.statusCode, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(settings.body)?.[1];
    assert.ok(csrf);
    const post = async (values: Record<string, string>) => {
      const response = await app.inject({ method: 'POST', url: '/admin/settings', headers: { cookie }, payload: { csrf, ...values } });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/admin/settings?saved=1');
      // Verify persisted database values, rather than only the process cache.
      await loadOptions(true);
    };
    const page = async (url: string, locale: string, authenticated = false) => {
      if (authenticated) await exec('UPDATE users SET locale=? WHERE uid=?', [locale, uid]);
      const response = await app.inject({ url: url + (url.includes('?') ? '&' : '?') + 'lang=' + locale, headers: authenticated ? { cookie } : {} });
      assert.equal(response.statusCode, 200, url);
      return response.body;
    };
    const announcement = (html: string) => {
      const section = /<section\b[^>]*aria-labelledby="announcement-title"[^>]*>([\s\S]*?)<\/section>/.exec(html);
      assert.ok(section, 'The public homepage must contain an announcement section');
      return section[1];
    };

    await t.test('localized announcement fields save and reload without hiding legacy values', async () => {
      await post({ announcement: 'Default announcement fixture', announcement_zh_CN: '中文公告测试', announcement_en: 'English announcement fixture' });
      const reloaded = await page('/admin/settings', 'zh_CN', true);
      for (const [key, value] of Object.entries({ announcement: 'Default announcement fixture', announcement_zh_CN: '中文公告测试', announcement_en: 'English announcement fixture' })) {
        assert.equal(await getOption(key), value);
        assert.match(reloaded, new RegExp('<textarea[^>]*name="' + key + '"[^>]*>' + value + '</textarea>'));
      }
    });

    await t.test('all public homepage layouts and the user center display the active language', async () => {
      for (const layout of ['split', 'classic', 'gallery', 'minimal']) {
        await setOption('home_layout', layout);
        await loadOptions(true);
        for (const [locale, expected, other] of [['zh_CN', '中文公告测试', 'English announcement fixture'], ['en', 'English announcement fixture', '中文公告测试']]) {
          const content = announcement(await page('/', locale));
          assert.ok(content.includes(expected), layout + ': ' + locale);
          assert.ok(!content.includes(other), layout + ': ' + locale);
          const userPage = await page('/user', locale, true);
          assert.ok(userPage.includes(expected), '/user: ' + locale);
          assert.ok(!userPage.includes(other), '/user: ' + locale);
        }
      }
    });

    await t.test('blank language overrides use the configured default before English fallback', async () => {
      await post({
        announcement: 'Updated default announcement fixture', announcement_zh_CN: '', announcement_en: 'English fallback fixture',
        site_description: 'Default description fixture', site_description_zh_CN: '', site_description_en: 'English description fixture',
      });
      const chinese = await page('/', 'zh_CN');
      assert.ok(announcement(chinese).includes('Updated default announcement fixture'));
      assert.ok(!announcement(chinese).includes('English fallback fixture'));
      assert.match(chinese, /name="description" content="Default description fixture"/);
      assert.ok(announcement(await page('/', 'en')).includes('English fallback fixture'));
      await post({ announcement: '' });
      assert.ok(announcement(await page('/', 'zh_CN')).includes('English fallback fixture'));
    });

    await t.test('an unset English site name falls back to the customized default', async () => {
      await post({ site_name: 'Customized default site fixture', site_name_zh_CN: '', site_name_en: '' });
      await exec('DELETE FROM options WHERE option_name=?', ['site_name_en']);
      await loadOptions(true);
      for (const locale of ['zh_CN', 'en']) {
        const html = await page('/', locale);
        assert.match(html, /<title>Customized default site fixture<\/title>/);
        assert.match(html, /<h1>Customized default site fixture<\/h1>/);
      }
    });

    await t.test('Markdown is sanitized and clearing every announcement removes its section', async () => {
      await post({
        announcement: '**Safe announcement fixture**\n\n<script>window.__announcement_attack=1</script>\n\n[unsafe](javascript:alert(1)) <img src="/app/bg.webp" onerror="window.__announcement_attack=2">',
        announcement_zh_CN: '', announcement_en: '',
      });
      for (const locale of ['zh_CN', 'en']) {
        const publicPage = await page('/', locale);
        const content = announcement(publicPage);
        assert.match(content, /<strong>Safe announcement fixture<\/strong>/);
        assert.doesNotMatch(content, /<script|javascript:|onerror|__announcement_attack/i);
        const userPage = await page('/user', locale, true);
        assert.match(userPage, /<strong>Safe announcement fixture<\/strong>/);
        assert.doesNotMatch(userPage, /__announcement_attack|javascript:alert\(1\)/);
      }
      await post({ announcement: '', announcement_zh_CN: '', announcement_en: '' });
      for (const locale of ['zh_CN', 'en']) {
        assert.doesNotMatch(await page('/', locale), /aria-labelledby="announcement-title"/);
        assert.doesNotMatch(await page('/user', locale, true), /class="card-title">(?:站点公告|Announcement)<\/h2>/);
      }
    });

    await t.test('the saved OIDC issuer reaches discovery and clears back to site URL', async () => {
      const originalIssuer = config.oidcIssuer;
      try {
        config.oidcIssuer = '';
        const configured = 'https://issuer.example.test';
        await post({ ygg_connect_server_url: configured });
        assert.equal(await getOption('ygg_connect_server_url'), configured);
        assert.match(await page('/admin/settings', 'zh_CN', true), /name="ygg_connect_server_url" value="https:\/\/issuer\.example\.test"/);
        const discovery = await app.inject('/.well-known/openid-configuration');
        assert.equal(discovery.statusCode, 200);
        assert.equal(discovery.json().issuer, configured);
        await post({ ygg_connect_server_url: '' });
        const fallback = await app.inject('/.well-known/openid-configuration');
        assert.equal(fallback.statusCode, 200);
        assert.equal(fallback.json().issuer, (await getOption('site_url', 'http://localhost:3000')).replace(/\/+$/, ''));
        for (const value of ['javascript:alert(1)', 'https:issuer.example.test', 'https://user:secret@issuer.example.test', 'https://issuer.example.test?x=1', 'https://issuer.example.test/#fragment', 'https://issuer.example.test/\\path']) {
          const rejected = await app.inject({ method: 'POST', url: '/admin/settings', headers: { cookie }, payload: { csrf, ygg_connect_server_url: value } });
          assert.equal(rejected.headers.location, '/admin/settings?error=oidc-issuer#ygg');
          assert.equal(await getOption('ygg_connect_server_url'), '');
        }
        config.oidcIssuer = 'https://environment.example.test';
        await post({ ygg_connect_server_url: configured });
        assert.equal((await app.inject('/.well-known/openid-configuration')).json().issuer, config.oidcIssuer);
        assert.match(await page('/admin/settings', 'zh_CN', true), /name="ygg_connect_server_url" value="https:\/\/environment\.example\.test" disabled/);
      } finally { config.oidcIssuer = originalIssuer; }
    });

    await t.test('saved player name rules affect new players immediately without restarting', async () => {
      await setOption('plugins_enabled', '[]');
      await setOption('max_players_per_user', '0');
      await setOption('score_per_player', '0');
      await post({ player_name_rule: 'official', player_name_length_min: '3', player_name_length_max: '16' });
      const create = (name: string) => app.inject({ method: 'POST', url: '/user/player', headers: { cookie }, payload: { csrf, action: 'add', name } });
      const customName = '规则' + crypto.randomBytes(4).toString('hex');
      const rejected = await create(customName);
      assert.equal(rejected.statusCode, 400);
      await post({ player_name_rule: 'utf8', player_name_length_min: '3', player_name_length_max: '16' });
      const accepted = await create(customName);
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().code, 0);
      await post({ player_name_length_min: '12', player_name_length_max: '16' });
      assert.equal((await create('ShortName')).statusCode, 400);
    });

    await t.test('the dashboard sign-in button honors the saved interval', async () => {
      await post({ sign_after_zero: 'false', sign_gap_time: '48' });
      await exec('UPDATE users SET last_sign_at=? WHERE uid=?', [nowString(-24 * 3600), uid]);
      assert.match(await page('/user', 'zh_CN', true), /<button id="sign-btn"[^>]* disabled/);
      await post({ sign_gap_time: '2' });
      await exec('UPDATE users SET last_sign_at=? WHERE uid=?', [nowString(-3 * 3600), uid]);
      const available = await page('/user', 'zh_CN', true);
      assert.match(available, /<button id="sign-btn"/);
      assert.doesNotMatch(available, /<button id="sign-btn"[^>]* disabled/);
    });
  } finally {
    await exec(`DELETE FROM options WHERE option_name IN (${placeholders})`, keys);
    for (const row of before) await exec('INSERT INTO options (id,option_name,option_value) VALUES (?,?,?)', [row.id, row.option_name, row.option_value]);
    await loadOptions(true);
    await loadPlayerNameRules();
    if (uid) {
      await exec('DELETE FROM `uuid` WHERE name IN (SELECT name FROM players WHERE uid=?)', [uid]);
      await exec('DELETE FROM players WHERE uid=?', [uid]);
      await exec('DELETE FROM mcn_web_sessions WHERE user_id=?', [uid]);
      await exec('DELETE FROM users WHERE uid=?', [uid]);
    }
    await app.close();
    await pool.end();
  }
});
