import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, queryOne, exec, insert, nowString, withTransaction } from '../db.js';
import { getOption, getOptionInt } from './option.js';
import { revokeAllTokensForUser } from './token.js';
import { singlePlayerLimitEnabled } from './player.js';
import { normalizeUuid } from './uuid.js';

export type MinecraftIdentity = { uuid: string; name: string };
export type MojangConfiguration = { clientId: string; clientSecret: string; redirectUri: string; configured: boolean; problem: string | null };
export class MojangVerificationError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
export async function mojangConfiguration(): Promise<MojangConfiguration> {
  const clientId = process.env.MICROSOFT_KEY ?? '';
  const clientSecret = process.env.MICROSOFT_SECRET ?? '';
  const origin = config.publicOrigin || await getOption('site_url', 'http://localhost:3000');
  const redirectUri = config.publicOrigin ? `${config.publicOrigin}/mojang/callback` : process.env.MICROSOFT_REDIRECT_URI || `${origin.replace(/\/$/, '')}/mojang/callback`;
  let problem: string | null = null;
  if (!clientId || !clientSecret) problem = '本站暂未配置 Microsoft 正版验证，请联系管理员。';
  try {
    const url = new URL(redirectUri);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== new URL(origin).origin || url.pathname !== '/mojang/callback' || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) problem = 'Microsoft 回调地址配置不正确，请联系管理员。';
  } catch { problem = 'Microsoft 回调地址配置不正确，请联系管理员。'; }
  return { clientId, clientSecret, redirectUri, configured: !problem, problem };
}
export function microsoftVerificationUrl(settings: MojangConfiguration, state: string, verifier: string): string {
  if (!settings.configured) throw new MojangVerificationError('not_configured', settings.problem ?? 'Microsoft 验证尚未配置', 503);
  const url = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
  for (const [key, value] of Object.entries({ client_id: settings.clientId, response_type: 'code', redirect_uri: settings.redirectUri, response_mode: 'query', scope: 'XboxLive.signin', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' })) url.searchParams.set(key, value);
  return url.toString();
}
async function upstreamJson(fetcher: typeof fetch, url: string, options: RequestInit, stage: string): Promise<any> {
  let response: Response;
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new MojangVerificationError('upstream_unavailable', '认证服务暂时不可用，请稍后重新验证。', 502); }
  let data: any;
  try { data = await response.json(); } catch { throw new MojangVerificationError('upstream_response', '认证服务返回了无效响应，请稍后重新验证。', 502); }
  if (stage === 'xsts' && data?.XErr) {
    const details: Record<string, string> = {
      '2148916233': '此 Microsoft 账户尚未创建 Xbox 档案，请先到 Xbox 官网完成设置。',
      '2148916235': '此账户所在的地区暂不支持 Xbox Live。',
      '2148916236': '此账户需要先完成 Xbox 年龄验证。',
      '2148916237': '此账户需要先完成 Xbox 年龄验证。',
      '2148916238': '此账户需要在 Microsoft 家庭组中完成家长许可。',
    };
    throw new MojangVerificationError('xsts_denied', details[String(data.XErr)] ?? 'Xbox 未批准此次认证，请检查账户设置。', 403);
  }
  if (!response.ok || data?.error) {
    if (stage === 'profile' && response.status === 404) throw new MojangVerificationError('not_owned', '此账户没有可用的 Minecraft Java 版角色。', 403);
    throw new MojangVerificationError('upstream_denied', stage === 'microsoft' ? 'Microsoft 未能完成授权，请重新发起验证。' : 'Minecraft 认证未通过，请检查账户后重新验证。', response.status >= 500 ? 502 : 403);
  }
  return data;
}
/** No access/refresh tokens leave this function or get persisted. fetcher is injectable for isolated protocol tests. */
export async function resolveMinecraftIdentity(settings: MojangConfiguration, code: string, verifier: string, fetcher: typeof fetch = fetch): Promise<MinecraftIdentity> {
  if (!settings.configured || !code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new MojangVerificationError('invalid_request', '此次验证已失效，请重新发起验证。');
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: settings.clientId, client_secret: settings.clientSecret, redirect_uri: settings.redirectUri, code, code_verifier: verifier, scope: 'XboxLive.signin' });
  const microsoft = await upstreamJson(fetcher, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form }, 'microsoft');
  if (typeof microsoft.access_token !== 'string' || !microsoft.access_token) throw new MojangVerificationError('upstream_response', 'Microsoft 没有返回访问凭证。', 502);
  const jsonPost = (body: object): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const xbox = await upstreamJson(fetcher, 'https://user.auth.xboxlive.com/user/authenticate', jsonPost({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoft.access_token}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }), 'xbox');
  if (typeof xbox.Token !== 'string' || !xbox.Token) throw new MojangVerificationError('upstream_response', 'Xbox 未返回有效的认证凭证。', 502);
  const xsts = await upstreamJson(fetcher, 'https://xsts.auth.xboxlive.com/xsts/authorize', jsonPost({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }), 'xsts');
  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (typeof xsts.Token !== 'string' || typeof uhs !== 'string' || !xsts.Token || !uhs) throw new MojangVerificationError('upstream_response', 'Xbox 未返回有效的账户信息。', 502);
  const minecraft = await upstreamJson(fetcher, 'https://api.minecraftservices.com/authentication/login_with_xbox', jsonPost({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }), 'minecraft');
  if (typeof minecraft.access_token !== 'string' || !minecraft.access_token) throw new MojangVerificationError('upstream_response', 'Minecraft 未返回有效的认证凭证。', 502);
  const headers = { Authorization: `Bearer ${minecraft.access_token}`, Accept: 'application/json' };
  const entitlements = await upstreamJson(fetcher, 'https://api.minecraftservices.com/entitlements/mcstore', { headers }, 'entitlements');
  if (!Array.isArray(entitlements.items) || entitlements.items.length === 0) throw new MojangVerificationError('not_owned', '此 Microsoft 账户未提供有效的 Minecraft Java 版所有权凭证。', 403);
  const profile = await upstreamJson(fetcher, 'https://api.minecraftservices.com/minecraft/profile', { headers }, 'profile');
  const uuid = typeof profile.id === 'string' ? normalizeUuid(profile.id) : null;
  if (!uuid || typeof profile.name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(profile.name)) throw new MojangVerificationError('invalid_profile', 'Minecraft 返回的角色信息无效。', 502);
  return { uuid, name: profile.name };
}
export type VerificationRow = { user_id: number; uuid: string; verified: number };
export async function verificationOf(userId: number): Promise<VerificationRow | null> {
  return queryOne<VerificationRow>('SELECT user_id,uuid,verified FROM mojang_verifications WHERE user_id=?', [userId]);
}
/** Proof has already been obtained from Microsoft/Xbox/Minecraft, never from request body fields. */
export async function bindMinecraftIdentity(userId: number, identity: MinecraftIdentity): Promise<{ alreadyVerified: boolean; reward: number; uuidSynced: boolean }> {
  const normalized = normalizeUuid(identity.uuid);
  if (!normalized || !/^[A-Za-z0-9_]{1,16}$/.test(identity.name)) throw new MojangVerificationError('invalid_profile', '正版角色信息无效。');
  return withTransaction(async () => {
    const user = await queryOne<{ uid: number; permission: number }>('SELECT uid,permission FROM users WHERE uid=? FOR UPDATE', [userId]);
    if (!user || user.permission === -1) throw new MojangVerificationError('account_unavailable', '当前账户不可用。', 403);
    const previous = await queryOne<VerificationRow>('SELECT user_id,uuid,verified FROM mojang_verifications WHERE user_id=? FOR UPDATE', [userId]);
    if (previous?.verified) {
      if (normalizeUuid(previous.uuid) === normalized) return { alreadyVerified: true, reward: 0, uuidSynced: !!await queryOne('SELECT id FROM `uuid` WHERE uuid=?', [normalized]) };
      throw new MojangVerificationError('already_bound', '此皮肤站账户已绑定其他正版账户。', 409);
    }
    const occupied = await queryOne<VerificationRow>('SELECT user_id,uuid,verified FROM mojang_verifications WHERE uuid=? FOR UPDATE', [normalized]);
    if (occupied && occupied.user_id !== userId) throw new MojangVerificationError('uuid_conflict', '此正版账户已经绑定其他皮肤站账户。', 409);
    const player = await queryOne<{ pid: number; uid: number; name: string }>('SELECT pid,uid,name FROM players WHERE name=? FOR UPDATE', [identity.name]);
    if (player && player.uid !== userId) throw new MojangVerificationError('player_conflict', '此角色名称已被其他皮肤站账户使用，请联系管理员处理归属。', 409);
    if (!player && await singlePlayerLimitEnabled() && await queryOne('SELECT pid FROM players WHERE uid=? LIMIT 1 FOR UPDATE', [userId])) throw new MojangVerificationError('player_limit', '单角色模式下，请先处理当前角色，再绑定正版角色。', 409);
    const duplicate = await queryOne<{ name: string }>('SELECT name FROM `uuid` WHERE uuid=? AND name<>? LIMIT 1 FOR UPDATE', [normalized, identity.name]);
    if (duplicate) throw new MojangVerificationError('uuid_conflict', '此正版 UUID 已关联其他角色，请联系管理员核对。', 409);
    if (!player) await exec('INSERT INTO players (uid,name,tid_skin,tid_cape,last_modified) VALUES (?,?,0,0,?)', [userId, identity.name, nowString()]);
    const mapping = await queryOne<{ uuid: string }>('SELECT uuid FROM `uuid` WHERE name=? ORDER BY id ASC LIMIT 1 FOR UPDATE', [identity.name]);
    if (!mapping) await exec('INSERT INTO `uuid` (name,uuid) VALUES (?,?)', [identity.name, normalized]);
    if (previous) await exec('UPDATE mojang_verifications SET uuid=?,verified=1,updated_at=? WHERE user_id=?', [normalized, nowString(), userId]);
    else await exec('INSERT INTO mojang_verifications (user_id,uuid,verified,created_at,updated_at) VALUES (?,?,1,?,?)', [userId, normalized, nowString(), nowString()]);
    const reward = Math.max(0, await getOptionInt('mojang_verification_score_award', 0));
    if (reward) await exec('UPDATE users SET score=score+? WHERE uid=?', [reward, userId]);
    if (await singlePlayerLimitEnabled()) await exec('UPDATE users SET nickname=? WHERE uid=?', [identity.name, userId]);
    return { alreadyVerified: false, reward, uuidSynced: !mapping || normalizeUuid(mapping.uuid) === normalized };
  }).catch((error) => {
    if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK'].includes((error as any)?.code)) throw new MojangVerificationError('binding_conflict', '角色或正版账户的绑定信息发生冲突，请刷新后重新验证。', 409);
    throw error;
  });
}
export async function synchronizeVerifiedUuid(userId: number, fetcher: typeof fetch = fetch): Promise<void> {
  await withTransaction(async () => {
    const user = await queryOne('SELECT uid FROM users WHERE uid=? AND permission<>-1 FOR UPDATE', [userId]);
    if (!user) throw new MojangVerificationError('account_unavailable', '当前账户不可用。', 403);
    const verification = await queryOne<VerificationRow>('SELECT user_id,uuid,verified FROM mojang_verifications WHERE user_id=? FOR UPDATE', [userId]);
    if (!verification?.verified) throw new MojangVerificationError('not_verified', '请先完成正版验证。', 403);
    const uuid = normalizeUuid(verification.uuid);
    if (!uuid) throw new MojangVerificationError('invalid_uuid', '原正版验证记录中的 UUID 无效，请联系管理员。', 409);
    // UUID -> current profile lookup replaces the removed Mojang name-history API.
    let response: Response;
    try { response = await fetcher(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { throw new MojangVerificationError('upstream_unavailable', '暂时无法查询正版角色，请稍后重试。', 502); }
    const profile: any = response.ok ? await response.json() : null;
    if (!profile || normalizeUuid(String(profile.id ?? '')) !== uuid || !/^[A-Za-z0-9_]{1,16}$/.test(profile.name ?? '')) throw new MojangVerificationError('profile_unavailable', '正版角色信息暂时不可用，请稍后重试。', 502);
    const player = await queryOne<{ pid: number; uid: number }>('SELECT pid,uid FROM players WHERE name=? FOR UPDATE', [profile.name]);
    if (!player || player.uid !== userId) throw new MojangVerificationError('player_conflict', '只有本人名下、与正版名称一致的角色才能同步 UUID。', 409);
    const conflict = await queryOne('SELECT id FROM `uuid` WHERE uuid=? AND name<>? LIMIT 1 FOR UPDATE', [uuid, profile.name]);
    if (conflict) throw new MojangVerificationError('uuid_conflict', '此 UUID 已关联其他角色，请联系管理员核对。', 409);
    const exists = await queryOne('SELECT id FROM `uuid` WHERE name=? FOR UPDATE', [profile.name]);
    if (exists) await exec('UPDATE `uuid` SET uuid=? WHERE name=?', [uuid, profile.name]);
    else await exec('INSERT INTO `uuid` (name,uuid) VALUES (?,?)', [profile.name, uuid]);
    await revokeAllTokensForUser(userId);
  });
}
