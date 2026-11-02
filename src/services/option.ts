import { query, exec } from '../db.js';
import { config } from '../config.js';

/**
 * Site options stored in the `options` table (key-value), fully compatible with
 * Blessing Skin's option() helper. Defaults mirror config/options.php of BS 8.x.
 */
const DEFAULTS: Record<string, string> = {
  site_name: 'Natayark SkinServer',
  site_name_en: 'Natayark SkinServer',
  site_url: 'http://localhost:3000',
  site_description: '',
  announcement: '',
  announcement_en: '',
  copyright_text: '',
  meta_keywords: '',
  meta_description: '',
  meta_extras: '',
  custom_css: '',
  custom_js: '',
  favicon_url: '',
  home_pic_url: '',
  content_policy: '',
  textures_description_limit: '0',

  player_name_rule: 'utf8',
  custom_player_name_regexp: '',
  player_name_length_min: '3',
  player_name_length_max: '16',
  register_with_player_name: 'true',
  local_login_enabled: 'true',
  regs_per_ip: '3',
  require_verification: '0',
  user_initial_score: '1000',
  max_upload_file_size: '1024',
  texture_name_regexp: '',

  score_per_player: '100',
  max_players_per_user: '0',
  score_per_storage: '3',
  private_score_per_storage: '25',
  score_per_closet_item: '2',
  score_award_per_texture: '20',
  score_award_per_like: '5',
  reporter_score_modification: '10',
  reporter_reward_score: '0',
  take_back_scores_after_deletion: 'true',
  return_score: '0',
  status_code_for_private: '403',
  allow_downloading_texture: '0',
  auto_del_invalid_texture: 'true',

  sign_score: '10,100',
  sign_gap_time: '24',
  sign_after_zero: 'true',

  ygg_uuid_algorithm: 'v3',
  ygg_token_expire_1: '259200',
  ygg_token_expire_2: '604800',
  ygg_tokens_limit: '10',
  ygg_rate_limit: '1000',
  ygg_search_profile_max: '5',
  ygg_skin_domain: '',
  ygg_disable_authserver: 'false',
  ygg_private_key: '',
  ygg_show_config_section: 'true',

  // Yggdrasil Connect (built-in OIDC provider, replaces Janus)
  ygg_connect_server_url: '', // empty => same origin as site_url
  ygg_shared_client_id: '',
  yggc_device_code_expire: '900',
  yggc_grant_expire: '1209600',

  mojang_verification_score_award: '0',

  api_indicator: '1',
};

type Cache = { data: Map<string, string>; loadedAt: number };
const cache: Cache = { data: new Map(), loadedAt: 0 };
const TTL_MS = 30_000;

export async function loadOptions(force = false): Promise<void> {
  if (!force && Date.now() - cache.loadedAt < TTL_MS) return;
  const rows = await query<{ option_name: string; option_value: string }>(
    'SELECT option_name, option_value FROM options'
  );
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.option_name, row.option_value);
  cache.data = map;
  cache.loadedAt = Date.now();
}

export async function getOption(name: string): Promise<string | null>;
export async function getOption(name: string, defaultValue: string): Promise<string>;
export async function getOption(name: string, defaultValue?: string): Promise<string | null> {
  if (name === 'site_url' && config.publicOrigin) return config.publicOrigin;
  await loadOptions();
  const v = cache.data.get(name);
  if (v !== undefined) return v; // stored value wins, including empty string
  if (defaultValue !== undefined) return defaultValue;
  return DEFAULTS[name] ?? null;
}

export async function getOptionInt(name: string, defaultValue: number): Promise<number> {
  const v = await getOption(name);
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export async function getOptionBool(name: string, defaultValue: boolean): Promise<boolean> {
  const v = await getOption(name);
  if (v === null) return defaultValue;
  return v === 'true' || v === '1';
}

export async function setOption(name: string, value: string): Promise<void> {
  // Legacy options.option_name has no unique index. Update every old duplicate,
  // then insert only when absent; ON DUPLICATE KEY would append forever.
  const { withTransaction, queryOne } = await import('../db.js');
  await withTransaction(async () => {
    await exec('SELECT uid FROM users ORDER BY uid LIMIT 1 FOR UPDATE');
    const existing = await queryOne('SELECT id FROM options WHERE option_name = ? FOR UPDATE', [name]);
    if (existing) await exec('UPDATE options SET option_value = ? WHERE option_name = ?', [value, name]);
    else await exec('INSERT INTO options (option_name, option_value) VALUES (?, ?)', [name, value]);
  });
  cache.data.set(name, value);
}

/** Localized option like site_name / announcement (falls back through lang suffixes). */
export async function getOptionLocalized(name: string, locale: string): Promise<string> {
  const specific = await getOption(`${name}_${locale}`);
  if (specific !== null && specific !== '') return specific;
  const en = await getOption(`${name}_en`);
  if (en !== null && en !== '') return en;
  return (await getOption(name)) ?? '';
}
