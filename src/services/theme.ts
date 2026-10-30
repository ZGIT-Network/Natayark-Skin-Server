import { getOption, loadOptions, setOption } from './option.js';
import { withTransaction } from '../db.js';

export const APPEARANCE_DEFAULTS = {
  theme_primary: '#335cdb', theme_primary_dark: '#9bb7ff',
  theme_background: '#f4f6fb', theme_background_dark: '#111725',
  theme_default_mode: 'system', home_layout: 'split', home_show_recent: 'true',
};
export type Appearance = typeof APPEARANCE_DEFAULTS;
export const HOME_LAYOUTS = [
  { key: 'split', name: '分栏', description: '文字与图片并排，展示最近上传的材质。' },
  { key: 'classic', name: '经典大图', description: '背景大图与居中标题，接近经典皮肤站首页。' },
  { key: 'gallery', name: '皮肤库优先', description: '紧凑介绍与更多材质，适合分享型站点。' },
  { key: 'minimal', name: '简洁', description: '以站点名称与登录入口为主，不显示大图。' },
] as const;
export const PALETTES = [
  { name: '海蓝', light: '#335cdb', dark: '#9bb7ff', background: '#f4f6fb', night: '#111725' },
  { name: '松绿', light: '#16745b', dark: '#7ed9b2', background: '#f2f7f4', night: '#111f1b' },
  { name: '赤陶', light: '#b34332', dark: '#f2ad94', background: '#faf4ef', night: '#251a17' },
  { name: '紫罗兰', light: '#7847bf', dark: '#c9adff', background: '#f7f3fc', night: '#1c1628' },
];
export function isColor(value: unknown): value is string { return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value); }
export function isThemeMode(value: unknown): value is 'system' | 'light' | 'dark' { return ['system', 'light', 'dark'].includes(String(value)); }
export function isHomeLayout(value: unknown): value is typeof HOME_LAYOUTS[number]['key'] { return HOME_LAYOUTS.some(layout => layout.key === value); }

export async function appearanceSettings(): Promise<Appearance> {
  const values = { ...APPEARANCE_DEFAULTS };
  for (const key of Object.keys(values) as Array<keyof Appearance>) {
    const value = await getOption(key, values[key]);
    if (key.startsWith('theme_') && key !== 'theme_default_mode' && !isColor(value)) continue;
    if (key === 'theme_default_mode' && !isThemeMode(value)) continue;
    if (key === 'home_layout' && !isHomeLayout(value)) continue;
    if (key === 'home_show_recent' && !['true', 'false'].includes(value)) continue;
    values[key] = value;
  }
  return values;
}

export function parseAppearance(body: Record<string, unknown>, current: Appearance): Appearance | null {
  const next = { ...current };
  for (const key of Object.keys(next) as Array<keyof Appearance>) {
    if (body[key] === undefined) continue;
    const value = String(body[key]).trim();
    if (key.startsWith('theme_') && key !== 'theme_default_mode' && !isColor(value)) return null;
    if (key === 'theme_default_mode' && !isThemeMode(value)) return null;
    if (key === 'home_layout' && !isHomeLayout(value)) return null;
    if (key === 'home_show_recent' && !['true', 'false'].includes(value)) return null;
    next[key] = key.startsWith('theme_') ? value.toLowerCase() : value;
  }
  return next;
}

export async function saveAppearance(settings: Appearance, extras: Record<string, string> = {}): Promise<void> {
  try {
    await withTransaction(async () => {
      for (const [key, value] of Object.entries({ ...settings, ...extras })) await setOption(key, value);
    });
  } catch (error) { await loadOptions(true); throw error; }
}

function rgb(hex: string): number[] { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)); }
export function mix(a: string, b: string, amount: number): string {
  const one = rgb(a), two = rgb(b);
  return '#' + one.map((channel, index) => Math.round(channel * (1 - amount) + two[index] * amount).toString(16).padStart(2, '0')).join('');
}
function luminance(color: string): number {
  return rgb(color).map(channel => channel / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
export function contrast(a: string, b: string): number { const one = luminance(a), two = luminance(b); return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05); }
function foreground(background: string): string {
  if (contrast('#17202e', background) >= 4.5) return '#17202e';
  return contrast('#ffffff', background) >= 4.5 ? '#ffffff' : '#000000';
}
function readable(color: string, background: string): string {
  const target = foreground(background);
  for (let amount = 0; amount <= 1; amount += 0.025) {
    const candidate = mix(color, target, amount);
    if (contrast(candidate, background) >= 4.5) return candidate;
  }
  return target;
}
export function paletteVariables(primary: string, background: string): Record<string, string> {
  const text = foreground(background);
  const candidate = mix(background, '#ffffff', text === '#ffffff' ? 0.045 : 0.84);
  const card = contrast(text, candidate) >= 4.5 ? candidate : background;
  const border = mix(background, text, 0.16), soft = mix(card, primary, 0.10);
  const brand = readable(primary, card);
  return {
    background, foreground: text, card, 'card-foreground': text, popover: card, 'popover-foreground': text,
    primary, 'primary-foreground': foreground(primary), secondary: soft, 'secondary-foreground': text,
    muted: mix(card, text, 0.045), 'muted-foreground': readable(mix(card, text, 0.58), card),
    accent: soft, 'accent-foreground': text, border, input: border, ring: brand,
    brand, 'brand-strong': brand, 'brand-foreground': foreground(primary), 'brand-soft': soft,
    sidebar: mix(background, primary, 0.055), 'sidebar-foreground': readable(mix(background, text, 0.7), background), 'sidebar-border': border,
  };
}
export function appearanceCss(settings: Appearance): string {
  const rule = (selector: string, variables: Record<string, string>) => `${selector}{${Object.entries(variables).map(([key, value]) => `--${key}:${value}`).join(';')}}`;
  return rule(':root', paletteVariables(settings.theme_primary, settings.theme_background)) + rule(':root.dark', paletteVariables(settings.theme_primary_dark, settings.theme_background_dark));
}
export async function themeContext() {
  const appearance = await appearanceSettings();
  return { appearance, themeCss: appearanceCss(appearance), themeDefaultMode: appearance.theme_default_mode };
}
