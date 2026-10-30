import crypto from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { query, queryOne, exec, insert, nowString, withTransaction } from '../db.js';
import { config } from '../config.js';
import { getOption, getOptionInt, setOption } from './option.js';
import { ensureSigningKey, getPrivateKey, getKeyId, SCOPES, issueAccessToken, issueRefreshToken, ACCESS_TOKEN_NAME, TokenError, type IssuedToken } from './token.js';
import { availableProfilesOf } from './profile.js';
import { findUserByUid } from './user.js';
import { randomHex } from '../util.js';

/**
 * Built-in Yggdrasil Connect provider (OAuth 2.0 + OpenID Connect).
 *
 * Replaces the external Janus deployment. State lives in the same `yggc_*`
 * tables Janus used (payload JSON column), clients live in `oauth_clients`.
 */

export type OidcClient = {
  id: number;
  user_id: number | null;
  name: string;
  secret: string | null;
  redirect: string;
  revoked: number;
};

export async function findClient(clientId: string): Promise<OidcClient | null> {
  if (!/^\d+$/.test(clientId)) return null;
  const row = await queryOne<OidcClient>('SELECT id, user_id, name, secret, redirect, revoked FROM oauth_clients WHERE id = ?', [
    parseInt(clientId, 10),
  ]);
  if (!row || row.revoked) return null;
  return row;
}

export function isPublicClient(client: OidcClient): boolean {
  return !client.secret || clientRedirects(client).some((uri) => { try { return new URL(uri).pathname === '/yggc/client/public'; } catch { return false; } });
}

export function clientRedirects(client: OidcClient): string[] {
  return client.redirect.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function createClient(input: { name: string; secret: string | null; redirects: string[]; ownerId?: number | null }): Promise<number> {
  return insert(
    'INSERT INTO oauth_clients (user_id, name, secret, provider, redirect, personal_access_client, password_client, revoked, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 0, 0, 0, ?, ?)',
    [input.ownerId ?? null, input.name, input.secret, input.redirects.join(','), nowString(), nowString()]
  );
}

const VALID_SCOPES = new Set<string>([...Object.values(SCOPES),
  'User.Read', 'Notification.Read', 'Notification.ReadWrite', 'Player.Read', 'Player.ReadWrite', 'Closet.Read', 'Closet.ReadWrite',
  'UsersManagement.Read', 'UsersManagement.ReadWrite', 'PlayersManagement.Read', 'PlayersManagement.ReadWrite',
  'ClosetManagement.Read', 'ClosetManagement.ReadWrite', 'ReportsManagement.Read', 'ReportsManagement.ReadWrite',
]);

export type ScopeValidation = { ok: true; scopes: string[] } | { ok: false; error: 'invalid_scope' | 'missing_openid' | 'conflicting_profiles' };

export function validateScopes(scopeString: string | undefined): ScopeValidation {
  const scopes = [...new Set((scopeString ?? '').split(' ').map((s) => s.trim()).filter(Boolean))];
  if (scopes.length === 0) return { ok: false, error: 'invalid_scope' };
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope)) return { ok: false, error: 'invalid_scope' };
  }
  const yggScopes = scopes.filter((s) => s.startsWith('Yggdrasil.'));
  if (yggScopes.length > 0 && !scopes.includes(SCOPES.OPENID)) return { ok: false, error: 'missing_openid' };
  if (scopes.includes(SCOPES.PROFILE_SELECT) && scopes.includes(SCOPES.PROFILE_READ)) {
    return { ok: false, error: 'conflicting_profiles' };
  }
  if (scopes.includes(SCOPES.SERVER_JOIN) && !scopes.includes(SCOPES.PROFILE_SELECT)) return { ok: false, error: 'invalid_scope' };
  return { ok: true, scopes };
}

// ---------------------------------------------------------------------------
// yggc_* persistence (payload JSON, same tables Janus used)

export type StoredRecord = { id: string; payload: any; uid: string | null; consumed: number };
type StoreTable = 'yggc_interactions' | 'yggc_grants' | 'yggc_authorization_codes' | 'yggc_device_codes' | 'yggc_refresh_tokens';
const consumable = (table: string) => ['yggc_authorization_codes', 'yggc_device_codes', 'yggc_refresh_tokens'].includes(table);

export async function yggcUpsert(table: StoreTable, id: string, payload: any, uid: string | null = null, consumed = false): Promise<void> {
  if (!consumable(table)) {
    await exec(`INSERT INTO ${table} (id, payload, uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload), uid = VALUES(uid), updated_at = VALUES(updated_at)`, [id, JSON.stringify(payload), uid, nowString(), nowString()]);
    return;
  }
  await exec(
    `INSERT INTO ${table} (id, payload, uid, consumed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), uid = VALUES(uid), consumed = GREATEST(consumed, VALUES(consumed)), updated_at = VALUES(updated_at)`,
    [id, JSON.stringify(payload), uid, consumed ? 1 : 0, nowString(), nowString()]
  );
}

export async function yggcFind(table: StoreTable, id: string, lock = false): Promise<StoredRecord | null> {
  const row = await queryOne<{ id: string; payload: any; uid: string | null; consumed: number }>(
    `SELECT id, payload, uid, ${consumable(table) ? 'consumed' : '0 AS consumed'} FROM ${table} WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  if (!row) return null;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const expiresAt = payload.expiresAt ?? payload.exp ?? (table === 'yggc_interactions' ? (payload.createdAt ?? 0) + 900 : null);
  if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return { id: row.id, payload, uid: row.uid, consumed: row.consumed };
}

export async function yggcDelete(table: 'yggc_interactions' | 'yggc_grants' | 'yggc_authorization_codes' | 'yggc_device_codes' | 'yggc_refresh_tokens', id: string): Promise<void> {
  await exec(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

export async function yggcFindByUserCode(userCode: string): Promise<StoredRecord | null> {
  const row = await queryOne<{ id: string; payload: any; consumed: number }>(
    'SELECT id, payload, consumed FROM yggc_device_codes WHERE userCode = ? ORDER BY created_at DESC LIMIT 1',
    [userCode]
  );
  if (!row) return null;
  return yggcFind('yggc_device_codes', row.id);
}

export async function yggcFindByUid(table: 'yggc_interactions' | 'yggc_grants' | 'yggc_device_codes' | 'yggc_sessions', uid: string): Promise<StoredRecord | null> {
  const row = await queryOne<{ id: string; payload: any }>(`SELECT id, payload FROM ${table} WHERE uid = ? LIMIT 1`, [uid]);
  if (!row) return null;
  return { id: row.id, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, uid, consumed: 0 };
}

// ---------------------------------------------------------------------------
// Issuer & discovery

export async function issuer(): Promise<string> {
  const configured = config.oidcIssuer;
  if (configured) return configured.replace(/\/+$/, '');
  return (await getOption('site_url', 'http://localhost:3000')).replace(/\/+$/, '');
}

export async function discoveryDocument(): Promise<Record<string, any>> {
  const iss = await issuer();
  const result: Record<string, any> = {
    issuer: iss,
    jwks_uri: `${iss}/connect/jwks`,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: Object.values(SCOPES),
    authorization_endpoint: `${iss}/connect/authorize`,
    device_authorization_endpoint: `${iss}/connect/device_authorize`,
    token_endpoint: `${iss}/connect/token`,
    userinfo_endpoint: `${iss}/connect/userinfo`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    revocation_endpoint: `${iss}/connect/revoke`,
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'nickname', 'picture', 'email', 'email_verified', 'selectedProfile', 'availableProfiles'],
  };
  const sharedClientId = await getOption('ygg_shared_client_id');
  if (sharedClientId) result.shared_client_id = sharedClientId;
  return result;
}

export async function jwksDocument(): Promise<Record<string, any>> {
  await ensureSigningKey();
  const { getPublicKey } = await import('./token.js');
  const jwk = await exportJWK(getPublicKey());
  return { keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: getKeyId() }] };
}

// ---------------------------------------------------------------------------
// Tokens

const CODE_TTL_SECONDS = 600;

export type TokenIssueInput = {
  clientId: string;
  accountId: number;
  scopes: string[];
  selectedProfile: string | null;
  grantId: string | null;
  nonce?: string | null;
};

export type TokenPair = {
  access_token: IssuedToken;
  refresh_token: string | null;
  id_token: string | null;
};

export async function issueTokenBundle(input: TokenIssueInput, withRefresh: boolean): Promise<TokenPair> {
  const client = await findClient(input.clientId);
  if (!client) throw new TokenError('Client is no longer active');
  const clientIdNum = Number(client.id);
  return withTransaction(async () => {
  if (input.grantId) {
    const grant = await yggcFind('yggc_grants', input.grantId);
    if (!grant || String(grant.payload.clientId) !== input.clientId || Number(grant.payload.accountId) !== input.accountId || input.scopes.some((scope) => !grant.payload.scopes?.includes(scope))) throw new TokenError('Authorization has expired or been revoked');
  }
  const access = await issueAccessToken({
    userId: input.accountId,
    clientId: clientIdNum,
    scopes: input.scopes,
    selectedProfile: input.selectedProfile,
    grantId: input.grantId,
  });
  const expire2 = await getOptionInt('ygg_token_expire_2', 604800);
  let refresh: string | null = null;
  if (withRefresh && input.scopes.includes(SCOPES.OFFLINE_ACCESS)) {
    refresh = await issueRefreshToken(access, expire2);
    await yggcUpsert('yggc_refresh_tokens', refresh, { ...input, accessTokenId: access.jti, expiresAt: Math.floor(Date.now() / 1000) + expire2 });
  }
  let idToken: string | null = null;
  if (input.scopes.includes(SCOPES.OPENID)) {
    idToken = await buildIdToken({
      clientId: String(clientIdNum),
      accountId: input.accountId,
      scopes: input.scopes,
      selectedProfile: input.selectedProfile,
      nonce: input.nonce ?? null,
    });
  }
  return { access_token: access, refresh_token: refresh, id_token: idToken };
  });
}

export async function buildIdToken(input: {
  clientId: string;
  accountId: number;
  scopes: string[];
  selectedProfile: string | null;
  nonce: string | null;
}): Promise<string> {
  await ensureSigningKey();
  const iss = await issuer();
  const expiresIn = await getOptionInt('ygg_token_expire_1', 259200);
  const user = await findUserByUid(input.accountId);

  const claims: Record<string, any> = {};
  if (input.scopes.includes(SCOPES.PROFILE) && user) {
    claims.nickname = user.nickname;
    claims.picture = `${iss}/avatar/user/${user.uid}`;
  }
  if (input.scopes.includes(SCOPES.EMAIL) && user) {
    claims.email = user.email;
    claims.email_verified = user.verified === 1;
  }
  if (input.scopes.includes(SCOPES.PROFILE_SELECT) && input.selectedProfile) {
    const { getNameByUuid } = await import('./uuid.js');
    claims.selectedProfile = { id: input.selectedProfile, name: await getNameByUuid(input.selectedProfile) };
  }
  if (input.scopes.includes(SCOPES.PROFILE_READ)) {
    claims.availableProfiles = await availableProfilesOf(input.accountId);
  }

  const payload = { ...claims, ...(input.nonce ? { nonce: input.nonce } : {}) };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: getKeyId(), typ: 'JWT' })
    .setIssuer(iss)
    .setSubject(String(input.accountId))
    .setAudience(input.clientId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(getPrivateKey());
}

/** UserInfo endpoint response for a verified token. */
export async function buildUserInfo(verified: { userId: number; scopes: string[]; selectedProfile: string | null }): Promise<Record<string, any>> {
  const iss = await issuer();
  const user = await findUserByUid(verified.userId);
  if (!user) return { sub: String(verified.userId) };
  const resp: Record<string, any> = { sub: String(user.uid) };
  if (verified.scopes.includes(SCOPES.PROFILE)) {
    resp.nickname = user.nickname;
    resp.picture = `${iss}/avatar/user/${user.uid}`;
  }
  if (verified.scopes.includes(SCOPES.EMAIL)) {
    resp.email = user.email;
    resp.email_verified = user.verified === 1;
  }
  if (verified.scopes.includes(SCOPES.PROFILE_SELECT) && verified.selectedProfile) {
    const { getNameByUuid } = await import('./uuid.js');
    resp.selectedProfile = { id: verified.selectedProfile, name: await getNameByUuid(verified.selectedProfile) };
  }
  if (verified.scopes.includes(SCOPES.PROFILE_READ)) {
    resp.availableProfiles = await availableProfilesOf(user.uid);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Grants (persistent consent records)

export async function findExistingGrant(clientId: string, accountId: number, scopes: string[]): Promise<StoredRecord | null> {
  const rows = await query<{ id: string; payload: any }>('SELECT id, payload FROM yggc_grants');
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (payload?.clientId !== clientId || payload?.accountId !== accountId) continue;
    const granted: string[] = payload.scopes ?? [];
    if ((payload.expiresAt ?? Number.MAX_SAFE_INTEGER) > Math.floor(Date.now() / 1000) && scopes.every((s) => granted.includes(s))) {
      return { id: row.id, payload, uid: null, consumed: 0 };
    }
  }
  return null;
}

export async function saveGrant(clientId: string, accountId: number, scopes: string[]): Promise<string> {
  const grantId = randomHex(12);
  await yggcUpsert('yggc_grants', grantId, { clientId, accountId, scopes, iat: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + Math.max(1, await getOptionInt('yggc_grant_expire', 1209600)) });
  return grantId;
}

export async function revokeUserGrantsForClient(accountId: number, clientId: string): Promise<void> {
  const rows = await query<{ id: string; payload: any }>('SELECT id, payload FROM yggc_grants');
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (payload?.clientId === clientId && payload?.accountId === accountId) {
      await yggcDelete('yggc_grants', row.id);
    }
  }
  // also revoke active tokens of that client+user
  await exec('UPDATE oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id = r.access_token_id SET r.revoked = 1 WHERE a.client_id = ? AND a.user_id = ?', [clientId, accountId]);
  await exec(
    'UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ? AND name = ? AND revoked = 0',
    [parseInt(clientId, 10), accountId, ACCESS_TOKEN_NAME]
  );
}

// ---------------------------------------------------------------------------
// PKCE

export function verifyPkce(challenge: string | undefined, verifier: string | undefined): boolean {
  if (!challenge) return true;
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  const digest = crypto.createHash('sha256').update(verifier, 'ascii').digest();
  const computed = digest.toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

// ---------------------------------------------------------------------------
// Device flow

export async function createDeviceCode(clientId: string, scopes: string[]): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}> {
  const deviceCode = randomHex(24);
  const userCode = generateUserCode();
  const ttl = await getOptionInt('yggc_device_code_expire', 900);
  await yggcUpsert(
    'yggc_device_codes',
    deviceCode,
    {
      clientId,
      scope: scopes.join(' '),
      status: 'pending',
      requestedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
      lastPoll: 0,
    },
    null,
    false
  );
  await exec('UPDATE yggc_device_codes SET userCode = ? WHERE id = ?', [userCode, deviceCode]);
  const iss = await issuer();
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${iss}/connect/device`,
    verification_uri_complete: `${iss}/connect/device?user_code=${userCode}`,
    expires_in: ttl,
    interval: 5,
  };
}

function generateUserCode(): string {
  // XXXX-XXXX, no ambiguous characters
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
