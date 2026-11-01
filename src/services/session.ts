import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { findUserByUid } from './user.js';
import { config } from '../config.js';
import { exec, queryOne, nowString } from '../db.js';

const COOKIE_NAME = 'mcnskin_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export type SessionData = { uid: number; iat: number; sid: string };
export const tokenHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
const sign = (payload: string): string => crypto.createHmac('sha256', config.appKey).update(payload).digest('base64url');

export function serializeSession(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function parseSession(cookieValue: string | undefined): SessionData | null {
  if (!cookieValue || cookieValue.length > 2048) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const a = Buffer.from(cookieValue.slice(dot + 1)), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(data.uid) || data.uid < 0 || !Number.isSafeInteger(data.iat)) return null;
    if (typeof data.sid !== 'string' || !/^[a-f0-9]{64}$/.test(data.sid)) return null;
    const age = Math.floor(Date.now() / 1000) - data.iat;
    return age >= -60 && age <= MAX_AGE_SECONDS ? data : null;
  } catch { return null; }
}
function writeCookie(reply: FastifyReply, data: SessionData,remember:boolean): void {
  reply.setCookie(COOKIE_NAME, serializeSession(data), {
    path: '/', httpOnly: true, sameSite: 'lax', ...(remember?{maxAge:MAX_AGE_SECONDS}:{}),
    secure: process.env.NODE_ENV === 'production',
  });
}
async function createSession(reply: FastifyReply, uid: number,remember=false): Promise<SessionData> {
  const data: SessionData = { uid, iat: Math.floor(Date.now() / 1000), sid: crypto.randomBytes(32).toString('hex') };
  if (uid) await exec('INSERT INTO mcn_web_sessions (sid_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [tokenHash(data.sid), uid, nowString(), nowString(MAX_AGE_SECONDS)]);
  writeCookie(reply, data,remember);
  return data;
}
export async function loadSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  request.session = parseSession(request.cookies[COOKIE_NAME]);
  request.currentUser = null;
  if (request.session?.uid) {
    const row = await queryOne<{ user_id: number | null }>(
      'SELECT user_id FROM mcn_web_sessions WHERE sid_hash = ? AND expires_at > ?',
      [tokenHash(request.session.sid), nowString()]);
    if (!row || (row.user_id ?? 0) !== request.session.uid) request.session = null;
  }
  if (request.session?.uid) {
    request.currentUser = await findUserByUid(request.session.uid);
    if (!request.currentUser || request.currentUser.permission === -1) {
      await exec('DELETE FROM mcn_web_sessions WHERE sid_hash = ?', [tokenHash(request.session.sid)]);
      request.session = null;
      request.currentUser = null;
    }
  }
  // Anonymous browser sessions make CSRF tokens browser-specific. Public game APIs do not need them.
  const pathname = request.url.split('?')[0];
  const browserPage = pathname === '/' || /^\/(?:auth|user|admin|skinlib)(?:\/|$)/.test(pathname)
    || /^\/connect\/(?:authorize|interaction|device)(?:\/|$)/.test(pathname);
  if (!request.session && browserPage) request.session = await createSession(reply, 0);
}
export async function setSessionCookie(reply: FastifyReply, uid: number,remember=true): Promise<void> {
  await createSession(reply, uid,remember);
}
export async function clearSessionCookie(reply: FastifyReply, request?: FastifyRequest): Promise<void> {
  if (request?.session) await exec('DELETE FROM mcn_web_sessions WHERE sid_hash = ?', [tokenHash(request.session.sid)]);
  reply.clearCookie(COOKIE_NAME, { path: '/', secure: process.env.NODE_ENV === 'production' });
}
export async function revokeUserSessions(uid: number): Promise<void> {
  await exec('DELETE FROM mcn_web_sessions WHERE user_id = ?', [uid]);
}
export function csrfToken(session: SessionData | null): string {
  return session ? sign('csrf:' + session.sid + ':' + session.uid) : '';
}
export function checkCsrf(request: FastifyRequest, token: string | undefined): boolean {
  if (typeof token !== 'string' || !token || token.length > 200 || !request.session) return false;
  const a = Buffer.from(token), b = Buffer.from(csrfToken(request.session));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Signed short-lived state for non-OAuth callers; external OAuth also uses persisted one-use state. */
export function oauthState(data: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + 600_000 }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function verifyOauthState<T = Record<string, unknown>>(state: string | undefined): T | null {
  if (!state || state.length > 8192) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = state.slice(0, dot), a = Buffer.from(state.slice(dot + 1)), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now() ? data as T : null;
  } catch { return null; }
}
