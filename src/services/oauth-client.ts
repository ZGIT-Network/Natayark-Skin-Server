import crypto from 'node:crypto';
import { getOption, setOption } from './option.js';
import { query, queryOne, exec, nowString, transaction } from '../db.js';
import { tokenHash } from './session.js';

export type OAuthProviderConfig = {
  key: string; displayName: string;
  authUrl: string; tokenUrl: string; userUrl: string;
  clientId: string; clientSecret: string; scope?: string;
  userIdField?: string; usernameField?: string; emailField?: string;
  emailVerifiedField?: string; pkce?: boolean;
  tokenAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
};
/** Endpoints and mapping from oldbf/plugins/oauth-natayark/.../Provider.php. */
export const NATAYARK_ID_PRESET: OAuthProviderConfig = {
  key: 'natayarkid', displayName: 'Natayark ID',
  authUrl: 'https://account.naids.com/oauth2/authorize',
  tokenUrl: 'https://account.naids.com/api/oauth2/token',
  userUrl: 'https://account.naids.com/api/api/user/data',
  clientId: '$' + '{NYKID_KEY}', clientSecret: '$' + '{NYKID_SECRET}',
  userIdField: 'data.id', usernameField: 'data.username', emailField: 'data.email',
  // Legacy provider does not document PKCE or an email_verified assertion.
  pkce: false,
};
export const MICROSOFT_LIVE_PRESET: OAuthProviderConfig = {
  key: 'live', displayName: 'Microsoft Live',
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  userUrl: 'https://graph.microsoft.com/v1.0/me',
  clientId: '$' + '{LIVE_KEY}', clientSecret: '$' + '{LIVE_SECRET}',
  scope: 'User.Read', userIdField: 'id', usernameField: 'displayName', emailField: 'userPrincipalName', pkce: true,
};
export function resolveProviderEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
}
export function validateProvider(provider: OAuthProviderConfig): boolean {
  if (!provider || !/^[a-zA-Z0-9_-]{1,64}$/.test(provider.key) || !provider.displayName || !provider.clientId) return false;
  for (const endpoint of [provider.authUrl, provider.tokenUrl, provider.userUrl]) {
    try {
      const url = new URL(endpoint);
      if (url.username || url.password || url.hash) return false;
      const local = process.env.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return false;
    } catch { return false; }
  }
  return !provider.tokenAuthMethod || ['client_secret_post', 'client_secret_basic', 'none'].includes(provider.tokenAuthMethod);
}
export async function loadProviders(): Promise<OAuthProviderConfig[]> {
  const raw = await getOption('oauth_providers', '');
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    const providers = Array.isArray(parsed) ? parsed.filter(validateProvider) : [];
    if (!providers.some((p: OAuthProviderConfig) => p.key === 'natayarkid') && process.env.NYKID_KEY && process.env.NYKID_SECRET) providers.push(NATAYARK_ID_PRESET);
    if (!providers.some((p: OAuthProviderConfig) => p.key === 'live') && process.env.LIVE_KEY && process.env.LIVE_SECRET) providers.push(MICROSOFT_LIVE_PRESET);
    return providers;
  } catch { return []; }
}
export async function saveProviders(providers: OAuthProviderConfig[]): Promise<void> {
  if (!Array.isArray(providers) || !providers.every(validateProvider) || new Set(providers.map(p => p.key)).size !== providers.length) throw new Error('Invalid OAuth provider configuration');
  await setOption('oauth_providers', JSON.stringify(providers));
}
export async function findProvider(key: string): Promise<OAuthProviderConfig | null> {
  return (await loadProviders()).find(p => p.key === key) ?? null;
}
function pick(obj: any, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}
export type OAuthUserInfo = { id: string; username: string; email: string; emailVerified: boolean };
export function mapOAuthUser(provider: OAuthProviderConfig, user: unknown): OAuthUserInfo | null {
  const subject = pick(user, provider.userIdField || 'id');
  if ((typeof subject !== 'string' && typeof subject !== 'number') || String(subject).length === 0 || String(subject).length > 255) return null;
  const text = (path: string) => { const v = pick(user, path); return typeof v === 'string' ? v : ''; };
  const verified = provider.emailVerifiedField ? pick(user, provider.emailVerifiedField) : false;
  return {
    id: String(subject), username: (text(provider.usernameField || 'username') || text('name')).slice(0, 50),
    email: text(provider.emailField || 'email').trim().toLowerCase(), emailVerified: verified === true || verified === 1,
  };
}
export async function exchangeCode(provider: OAuthProviderConfig, code: string, redirectUri: string, verifier?: string): Promise<OAuthUserInfo | null> {
  if (!validateProvider(provider)) return null;
  const clientId = resolveProviderEnv(provider.clientId), secret = resolveProviderEnv(provider.clientSecret);
  if (!clientId || ((provider.tokenAuthMethod ?? 'client_secret_post') !== 'none' && !secret)) return null;
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code });
  if (provider.pkce !== false) {
    if (!verifier) return null;
    body.set('code_verifier', verifier);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (provider.tokenAuthMethod === 'client_secret_basic') headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(clientId) + ':' + encodeURIComponent(secret)).toString('base64');
  else if (provider.tokenAuthMethod !== 'none') body.set('client_secret', secret);
  const tokenResp = await fetch(provider.tokenUrl, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!tokenResp.ok) return null;
  const tokenJson: any = await tokenResp.json();
  const accessToken = tokenJson?.access_token ?? tokenJson?.data?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const userResp = await fetch(provider.userUrl, {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  return userResp.ok ? mapOAuthUser(provider, await userResp.json()) : null;
}
export function buildAuthorizeUrl(provider: OAuthProviderConfig, redirectUri: string, state: string, verifier?: string): string {
  const url = new URL(provider.authUrl);
  url.searchParams.set('client_id', resolveProviderEnv(provider.clientId));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (provider.scope) url.searchParams.set('scope', provider.scope);
  if (provider.pkce !== false) {
    if (!verifier) throw new Error('PKCE verifier required');
    url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}
export type OAuthFlow = {
  provider: string; redirect: string; redirectUri?: string; verifier?: string; linkUid?: number;
  remote?: OAuthUserInfo; email?: string; nickname?: string; playerName?: string; ip?: string; share?: string;
  passwordHash?: string;
};
export async function createOAuthFlow(browserSid: string, stage: string, payload: OAuthFlow, ttl = 600): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await exec('INSERT INTO mcn_oauth_flows (token_hash, browser_hash, stage, payload, expires_at) VALUES (?, ?, ?, ?, ?)',
    [tokenHash(token), tokenHash(browserSid), stage, JSON.stringify(payload), nowString(ttl)]);
  return token;
}
export async function readOAuthFlow(token: string, browserSid: string, stage: string, consume = false): Promise<OAuthFlow | null> {
  if (!token || token.length > 100) return null;
  return transaction(async conn => {
    const [rows] = await conn.query<any[]>('SELECT payload FROM mcn_oauth_flows WHERE token_hash = ? AND browser_hash = ? AND stage = ? AND expires_at > ? FOR UPDATE',
      [tokenHash(token), tokenHash(browserSid), stage, nowString()]);
    if (!rows.length) return null;
    if (consume) await conn.query('DELETE FROM mcn_oauth_flows WHERE token_hash = ?', [tokenHash(token)]);
    try { return JSON.parse(rows[0].payload); } catch { return null; }
  });
}
export async function findIdentity(provider: string, subject: string): Promise<{ user_id: number } | null> {
  return queryOne('SELECT user_id FROM mcn_oauth_identities WHERE provider = ? AND subject = ?', [provider, subject]);
}
export async function identitiesOf(uid: number): Promise<Array<{ provider: string; display_name: string; created_at: string }>> {
  return query('SELECT provider, display_name, created_at FROM mcn_oauth_identities WHERE user_id = ? ORDER BY provider', [uid]);
}
export async function linkIdentity(uid: number, provider: string, remote: OAuthUserInfo): Promise<boolean> {
  try {
    await exec('INSERT INTO mcn_oauth_identities (provider, subject, user_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
      [provider, remote.id, uid, remote.username, nowString()]);
    return true;
  } catch (error: any) {
    if (error.code === 'ER_DUP_ENTRY') return false;
    throw error;
  }
}
