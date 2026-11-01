import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_DEFAULTS, PALETTES, RADIUS_PRESETS, appearanceCss, contrast, isColor, paletteVariables, parseAppearance } from '../src/services/theme.js';

test('appearance rejects CSS injection and unsupported theme or layout values', () => {
  assert.equal(isColor('#abc123'), true);
  for (const value of ['red', '#fff', '#ffffff;display:none', '</style>', '#12xyz4']) assert.equal(isColor(value), false);
  for (const body of [{ theme_primary: '</style>' }, { theme_default_mode: 'automatic' }, { theme_radius: '999px' }, { theme_radius: '</style>' }, { home_layout: '../../etc' }, { home_show_recent: 'maybe' }]) assert.equal(parseAppearance(body, APPEARANCE_DEFAULTS), null);
  assert.equal(parseAppearance({ theme_primary: '#ABC123', home_layout: 'classic' }, APPEARANCE_DEFAULTS)?.theme_primary, '#abc123');
  assert.match(appearanceCss(APPEARANCE_DEFAULTS), /:root\.dark\{/);
  for (const preset of RADIUS_PRESETS) {
    const settings = parseAppearance({ theme_radius: preset.key }, APPEARANCE_DEFAULTS);
    assert.ok(settings);
    assert.match(appearanceCss(settings), new RegExp(`--radius:${preset.pixels}px[;}]`));
  }
});

test('built-in and custom colors retain readable text on buttons, surfaces and links', () => {
  for (const preset of PALETTES) {
    for (const [primary, background] of [[preset.light, preset.background], [preset.dark, preset.night]]) {
      const vars = paletteVariables(primary, background);
      assert.ok(contrast(vars.primary, vars['primary-foreground']) >= 4.5, preset.name + ': button');
      assert.ok(contrast(vars.foreground, vars.background) >= 4.5, preset.name + ': background');
      assert.ok(contrast(vars['card-foreground'], vars.card) >= 4.5, preset.name + ': card');
      assert.ok(contrast(vars.brand, vars.card) >= 4.5, preset.name + ': link');
    }
  }
  for (const primary of ['#ffffff','#000000','#777777','#ffff00','#0000ff']) for (const background of ['#000000','#ffffff','#777777']) {
    const vars = paletteVariables(primary, background);
    assert.ok(contrast(vars.primary, vars['primary-foreground']) >= 4.5, `${primary} button`);
    assert.ok(contrast(vars['card-foreground'], vars.card) >= 4.5, `${background} card`);
  }
});
