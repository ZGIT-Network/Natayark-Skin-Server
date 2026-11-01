import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SignJWT, compactVerify, type JWTPayload } from 'jose';
import { query, queryOne, exec, insert, nowString, dateToLocalString, localStringToEpoch, withTransaction } from '../db.js';
import { config } from '../config.js';
import { getOption, getOptionInt, getOptionBool, setOption } from './option.js';
import { randomHex } from '../util.js';

export const ACCESS_TOKEN_NAME = 'Yggdrasil Connect';
let privateKey: crypto.KeyObject | null = null;
let publicKey: crypto.KeyObject | null = null;
let keyId = '';
let signingInitialization: Promise<void> | null = null;
const verificationKeys: crypto.KeyObject[] = [];

export async function ensureSigningKey(): Promise<void> {
  if (privateKey) return;
  signingInitialization ??= (async () => {
    const initialized=await withTransaction(async()=>{
      const lock='natayark:keys:'+crypto.createHash('sha256').update(config.db.database+':'+config.db.tablePrefix).digest('hex').slice(0,40);
      const acquired=await queryOne<{acquired:number}>('SELECT GET_LOCK(?,10) AS acquired',[lock]);
      if(acquired?.acquired!==1)throw new Error('Could not acquire signing key initialization lock');
      try{
        // Same lock order as setOption; read directly to avoid a stale process-local option cache.
        await exec('SELECT uid FROM users ORDER BY uid LIMIT 1 FOR UPDATE');
        const stored=async(name:string)=>(await queryOne<{option_value:string}>('SELECT option_value FROM options WHERE option_name=? LIMIT 1 FOR UPDATE',[name]))?.option_value||'';
        let pem=await stored('ygg_oidc_private_key');
        if(!pem){try{pem=await fs.readFile(path.join(config.storageDir,'oauth-private.key'),'utf8');}catch{}}
        const key=pem?crypto.createPrivateKey(pem):crypto.generateKeyPairSync('rsa',{modulusLength:3072}).privateKey;
        if(key.asymmetricKeyType!=='rsa')throw new Error('OIDC signing key must be RSA');
        const pub=crypto.createPublicKey(key),privatePem=key.export({type:'pkcs8',format:'pem'}).toString();
        const id=await stored('ygg_oidc_key_id')||crypto.createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex').slice(0,24);
        const texturePem=await stored('ygg_private_key')||privatePem;
        // Preserve an existing site's texture key; fresh installations receive a usable key.
        crypto.createPrivateKey(texturePem);
        await setOption('ygg_oidc_key_id',id);await setOption('ygg_oidc_private_key',privatePem);
        await setOption('ygg_oidc_public_key',pub.export({type:'spki',format:'pem'}).toString());
        await setOption('ygg_private_key',texturePem);
        return{key,pub,id,texturePem};
      }finally{await queryOne('SELECT RELEASE_LOCK(?) AS released',[lock]);}
    });
    const {key,pub,id,texturePem}=initialized;keyId=id;
    verificationKeys.push(pub);
    try { verificationKeys.push(crypto.createPublicKey(await fs.readFile(path.join(config.storageDir, 'oauth-public.key'), 'utf8'))); } catch {}
    verificationKeys.push(crypto.createPublicKey(texturePem));
    privateKey = key;
    publicKey = pub;
  })();
  try { await signingInitialization; } catch (error) { signingInitialization = null; throw error; }
}
export function getPublicKey(): crypto.KeyObject {
  if (!publicKey) throw new Error('signing key not initialized');
  return publicKey;
}
export function getPrivateKey(): crypto.KeyObject {
  if (!privateKey) throw new Error('signing key not initialized');
  return privateKey;
}
export function getKeyId(): string {
  if (!keyId) throw new Error('signing key not initialized');
  return keyId;
}
export async function getSystemClientId(): Promise<number> {
  const stored = await getOption('ygg_system_client_id');
  if (stored) {
    const row = await queryOne<{ id: number }>('SELECT id FROM oauth_clients WHERE id = ? AND revoked = 0', [stored]);
    if (row) return Number(row.id);
  }
  const existing = await queryOne<{ id: number }>("SELECT id FROM oauth_clients WHERE name = 'Yggdrasil (Built-in)' AND revoked = 0 LIMIT 1");
  if (existing) { await setOption('ygg_system_client_id', String(existing.id)); return Number(existing.id); }
  const id = await insert("INSERT INTO oauth_clients (user_id, name, secret, provider, redirect, personal_access_client, password_client, revoked, created_at, updated_at) VALUES (NULL, 'Yggdrasil (Built-in)', NULL, 'yggdrasil', '', 0, 0, 0, ?, ?)", [nowString(), nowString()]);
  await setOption('ygg_system_client_id', String(id));
  return id;
}
export const SCOPES = {
  OPENID: 'openid', PROFILE: 'profile', EMAIL: 'email', OFFLINE_ACCESS: 'offline_access',
  PROFILE_READ: 'Yggdrasil.PlayerProfiles.Read', PROFILE_SELECT: 'Yggdrasil.PlayerProfiles.Select', SERVER_JOIN: 'Yggdrasil.Server.Join',
} as const;
export const ALL_SCOPES: string[] = Object.values(SCOPES);
export type TokenRow = { id: string; user_id: number; client_id: number; name: string | null; scopes: string | null; revoked: number; created_at: string; expires_at: string | null };
export type IssuedToken = { jwt: string; jti: string; scopes: string[]; userId: number; clientId: number; clientToken: string | null; selectedProfile: string | null; expiresIn: number };
export type IssueOptions = { userId: number; clientId: number; scopes: string[]; clientToken?: string | null; selectedProfile?: string | null; grantId?: string | null; issuedAt?: Date };
export type VerifiedToken = { jti: string; userId: number; clientId: number; scopes: string[]; clientToken: string | null; selectedProfile: string | null; grantId?: string | null; row: TokenRow };
export class TokenError extends Error {}
export async function revokeTokenRow(jti: string): Promise<void> {
  await exec('UPDATE oauth_access_tokens SET revoked = 1 WHERE id = ?', [jti]);
  await exec('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE access_token_id = ?', [jti]);
}
export async function issueAccessToken(opts: IssueOptions): Promise<IssuedToken> {
  await ensureSigningKey();
  const expiresIn = Math.max(1, await getOptionInt('ygg_token_expire_1', 259200));
  const limit = Math.max(1, await getOptionInt('ygg_tokens_limit', 10));
  return withTransaction(async () => {
    const user = await queryOne<{ permission: number; verified: number }>('SELECT permission, verified FROM users WHERE uid = ? FOR UPDATE', [opts.userId]);
    if (!user || user.permission === -1 || ((await getOptionBool('require_verification', false)) && !user.verified)) throw new TokenError('Account is not available');
    if (opts.selectedProfile) {
      const { profileFromUuid } = await import('./profile.js');
      const profile = await profileFromUuid(opts.selectedProfile);
      if (!profile || profile.player.uid !== opts.userId) throw new TokenError('Profile is not owned by this account');
    }
    const rows = await query<{ id: string }>('SELECT id FROM oauth_access_tokens WHERE user_id = ? AND client_id = ? AND name = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at ASC, id ASC FOR UPDATE', [opts.userId, opts.clientId, ACCESS_TOKEN_NAME, nowString()]);
    for (const row of rows.slice(0, Math.max(0, rows.length - limit + 1))) await revokeTokenRow(row.id);
    const jti = randomHex(32);
    const issuedAt = opts.issuedAt ?? new Date();
    const exp = new Date(issuedAt.getTime() + expiresIn * 1000);
    const jwt = await new SignJWT({ scopes: opts.scopes, ...(opts.clientToken !== undefined && opts.clientToken !== null ? { ct: opts.clientToken } : {}), ...(opts.selectedProfile ? { selectedProfile: opts.selectedProfile } : {}), ...(opts.grantId ? { grantId: opts.grantId } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: getKeyId(), typ: 'JWT' }).setSubject(String(opts.userId)).setAudience(String(opts.clientId))
      .setIssuedAt(issuedAt).setNotBefore(issuedAt).setExpirationTime(exp).setJti(jti).sign(getPrivateKey());
    await exec('INSERT INTO oauth_access_tokens (id, user_id, client_id, name, scopes, revoked, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', [jti, opts.userId, opts.clientId, ACCESS_TOKEN_NAME, JSON.stringify(opts.scopes), dateToLocalString(issuedAt), dateToLocalString(exp)]);
    return { jwt, jti, scopes: opts.scopes, userId: opts.userId, clientId: opts.clientId, clientToken: opts.clientToken ?? null, selectedProfile: opts.selectedProfile ?? null, expiresIn };
  });
}
export async function verifyAccessToken(jwt: string, options: { allowExpiredForRefresh?: boolean } = {}): Promise<VerifiedToken | null> {
  await ensureSigningKey();
  let payload: JWTPayload | undefined;
  for (const key of verificationKeys) {
    try { const result = await compactVerify(jwt, key, { algorithms: ['RS256'] }); payload = JSON.parse(Buffer.from(result.payload).toString('utf8')); break; } catch {}
  }
  if (!payload || typeof payload.jti !== 'string' || !Number.isFinite(payload.exp)) return null;
  const now = Date.now() / 1000;
  if (typeof payload.nbf === 'number' && payload.nbf > now) return null;
  if (!options.allowExpiredForRefresh && payload.exp! <= now) return null;
  const row = await queryOne<TokenRow>('SELECT * FROM oauth_access_tokens WHERE id = ?', [payload.jti]);
  if (!row || row.revoked) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(String(row.client_id)) || String(row.user_id) !== String(payload.sub)) return null;
  if (!options.allowExpiredForRefresh && (!row.expires_at || localStringToEpoch(row.expires_at) <= Date.now())) return null;
  if (options.allowExpiredForRefresh && !(await isRefreshable(row))) return null;
  const client = await queryOne<{ revoked: number }>('SELECT revoked FROM oauth_clients WHERE id = ?', [row.client_id]);
  if (!client || client.revoked) return null;
  const { findUserByUid } = await import('./user.js');
  const user = await findUserByUid(Number(row.user_id));
  if (!user || user.permission === -1 || ((await getOptionBool('require_verification', false)) && !user.verified)) return null;
  const selectedProfile = typeof payload.selectedProfile === 'string' ? payload.selectedProfile.replace(/-/g, '').toLowerCase() : null;
  if (selectedProfile) {
    const { profileFromUuid } = await import('./profile.js');
    const profile = await profileFromUuid(selectedProfile);
    if (!profile || profile.player.uid !== Number(row.user_id)) return null;
  }
  return { jti: payload.jti, userId: Number(row.user_id), clientId: Number(row.client_id), scopes: safeParseScopes(row.scopes), clientToken: typeof payload.ct === 'string' ? payload.ct : typeof payload.clientToken === 'string' ? payload.clientToken : null, selectedProfile, grantId: typeof payload.grantId === 'string' ? payload.grantId : null, row };
}
export function safeParseScopes(json: string | null): string[] {
  try { const parsed = JSON.parse(json ?? '[]'); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
export function hasScope(scopes: string[], scope: string): boolean { return scopes.includes(scope); }
export type RefreshTokenRecord = { id: string; access_token_id: string; revoked: number; expires_at: string | null };
export async function issueRefreshToken(accessToken: IssuedToken, ttlSeconds: number): Promise<string> {
  const jti = randomHex(32);
  await exec('INSERT INTO oauth_refresh_tokens (id, access_token_id, revoked, expires_at) VALUES (?, ?, 0, ?)', [jti, accessToken.jti, dateToLocalString(new Date(Date.now() + ttlSeconds * 1000))]);
  return jti;
}
export async function findRefreshToken(id: string, lock = false): Promise<RefreshTokenRecord | null> { return queryOne<RefreshTokenRecord>(`SELECT * FROM oauth_refresh_tokens WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]); }
export async function revokeRefreshToken(id: string): Promise<void> { await exec('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE id = ?', [id]); }
export async function isRefreshable(row: TokenRow): Promise<boolean> {
  const created = localStringToEpoch(row.created_at);
  return Number.isFinite(created) && Date.now() >= created && Date.now() - created < Math.max(1, await getOptionInt('ygg_token_expire_2', 604800)) * 1000;
}
export async function revokeAllTokensForUser(userId: number): Promise<void> {
  await withTransaction(async () => {
    await exec('UPDATE oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id = r.access_token_id SET r.revoked = 1 WHERE a.user_id = ?', [userId]);
    await exec('UPDATE oauth_access_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [userId]);
  });
}
