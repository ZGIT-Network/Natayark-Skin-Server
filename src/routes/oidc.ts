import crypto from 'node:crypto';
import { verifyPassword } from '../services/cipher.js';
import { withTransaction, queryOne, localStringToEpoch } from '../db.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  findClient,
  isPublicClient,
  clientRedirects,
  validateScopes,
  yggcUpsert,
  yggcFind,
  yggcDelete,
  yggcFindByUserCode,
  discoveryDocument,
  jwksDocument,
  issueTokenBundle,
  buildUserInfo,
  findExistingGrant,
  saveGrant,
  revokeUserGrantsForClient,
  verifyPkce,
  createDeviceCode,
} from '../services/oidc.js';
import {
  verifyAccessToken,
  findRefreshToken,
  revokeRefreshToken,
  revokeTokenRow,
  SCOPES,
  TokenError,
  type VerifiedToken,
} from '../services/token.js';
import { findUserByUid } from '../services/user.js';
import { availableProfilesOf } from '../services/profile.js';
import { getUuidByName } from '../services/uuid.js';
import { getOption } from '../services/option.js';
import { pageContext } from './page-context.js';

/**
 * Yggdrasil Connect endpoints (OAuth 2.0 + OIDC), replacing the external Janus.
 *
 * - GET  /.well-known/openid-configuration
 * - GET  /connect/jwks
 * - GET  /connect/authorize          (authorization code flow entry)
 * - GET  /connect/interaction/:uid   (login/consent UI)
 * - POST /connect/interaction/:uid/confirm | /deny
 * - POST /connect/device_authorize   (RFC 8628)
 * - GET  /connect/device             (user-code verification page)
 * - POST /connect/token
 * - GET  /connect/userinfo
 */

function oauthError(reply: FastifyReply, status: number, error: string, description?: string): FastifyReply {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return reply.code(status).send(body);
}

function clientAuthError(request: FastifyRequest, reply: FastifyReply, failure: {error:string;error_description:string}) {
  const status=failure.error==='invalid_client'?401:400;
  if(status===401 && /^Basic /i.test(String(request.headers.authorization))) reply.header('WWW-Authenticate','Basic realm="connect"');
  return oauthError(reply,status,failure.error,failure.error_description);
}

function redirectToClient(reply: FastifyReply, redirectUri: string, params: Record<string, string>): FastifyReply {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '') url.searchParams.set(key, value);
  }
  return reply.redirect(url.toString());
}

type ClientInfo = NonNullable<Awaited<ReturnType<typeof findClient>>>;

type CommittedResponse = () => FastifyReply | Promise<FastifyReply>;
/** Never expose a redirect, token or success response before its state commits. */
async function replyAfterCommit(work: () => Promise<CommittedResponse>): Promise<FastifyReply> {
  const respond = await withTransaction(work);
  return respond();
}

async function authenticateClient(request: FastifyRequest, clientIdParam?: string): Promise<{ client: ClientInfo; publicClient: boolean } | { error: string; error_description: string }> {
  let clientId = clientIdParam;
  let clientSecret: string | undefined;
  const auth = String(request.headers['authorization'] ?? '');
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 1) return { error: 'invalid_client', error_description: 'Malformed client authentication' };
    try {
      const basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
      if (clientId && clientId !== basicId) return { error: 'invalid_client', error_description: 'Conflicting client identities' };
      clientId = basicId;
      clientSecret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
    } catch { return { error: 'invalid_client', error_description: 'Malformed client authentication' }; }
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (typeof body.client_id === 'string') {
    if (clientId && body.client_id !== clientId) return { error: 'invalid_client', error_description: 'Conflicting client identities' };
    clientId = body.client_id;
  }
  if (typeof body.client_secret === 'string') {
    if (clientSecret !== undefined) return { error: 'invalid_request', error_description: 'Use one client authentication method' };
    clientSecret = body.client_secret;
  }

  if (!clientId) return { error: 'invalid_request', error_description: 'client_id is required' };
  const client = await findClient(clientId);
  if (!client) return { error: 'invalid_client', error_description: 'Unknown client' };
  const publicClient = isPublicClient(client) || await isSharedClient(client);
  if (!publicClient) {
    const expected = client.secret ?? '';
    const valid = clientSecret && (expected.startsWith('$2') ? await verifyPassword(clientSecret, expected) : crypto.timingSafeEqual(crypto.createHash('sha256').update(clientSecret).digest(), crypto.createHash('sha256').update(expected).digest()));
    if (!valid) {
      return { error: 'invalid_client', error_description: 'Client authentication failed' };
    }
  }
  return { client, publicClient };
}

async function currentUserUid(request: FastifyRequest): Promise<number | null> {
  return request.session?.uid ?? null;
}

async function renderInteraction(request: FastifyRequest, reply: FastifyReply, uid: string): Promise<FastifyReply> {
  const record = await yggcFind('yggc_interactions', uid);
  if (!record) return reply.code(404).view('error', { ...(await pageContext(request, '错误')), code: 404, message: '交互会话不存在或已过期。' });
  const params = record.payload.params as Record<string, string>;
  const scopes = (params.scope ?? '').split(' ').filter(Boolean);
  const client = await findClient(params.client_id ?? '');
  if (!client) return oauthError(reply, 400, 'invalid_request', 'Unknown client');

  const accountId = await currentUserUid(request);
  const needsLogin = !accountId;
  const needsSelect = scopes.includes(SCOPES.PROFILE_SELECT);
  let profiles: Array<{ id: string; name: string }> = [];
  if (accountId && needsSelect) {
    profiles = await availableProfilesOf(accountId);
  }
  return reply.view('yggc/interaction', {
    ...(await pageContext(request, 'Yggdrasil Connect')),
    error: profiles.length === 0 && needsSelect && accountId ? 'NO_PROFILES' : null,
    clientName: client.name,
    clientIsPublic: isPublicClient(client),
    scopes,
    profiles,
    uid,
    params,
    loggedIn: !needsLogin,
    needsSelect,
    csrf: request.csrfToken(),
  });
}

export async function registerOidcRoutes(app: FastifyInstance): Promise<void> {
  // --- Discovery ----------------------------------------------------------
  app.get('/.well-known/openid-configuration', async () => discoveryDocument());
  app.get('/connect/jwks', async () => jwksDocument());

  // --- Authorization code flow entry ---------------------------------------
  app.route({method:['GET','POST'],url:'/connect/authorize',handler:async (request, reply) => {
    const input=request.method==='POST'?request.body:request.query;
    if(!input || typeof input!=='object' || Array.isArray(input))return oauthError(reply,400,'invalid_request','Authorization parameters are required');
    const params = input as Record<string, string>;
    if (Object.values(params).some((v) => typeof v !== 'string')) return oauthError(reply, 400, 'invalid_request', 'Repeated authorization parameters are not supported');
    // Browser authorization identifies the client; its secret belongs at the token endpoint.
    const client = await findClient(params.client_id ?? '');
    if (!client) return oauthError(reply, 400, 'invalid_client', 'Unknown client');

    const redirectUri = params.redirect_uri ?? '';
    const registered = clientRedirects(client);
    const shared = await isSharedClient(client);
    const validRedirect =
      registered.some(uri=>registeredRedirectMatches(uri,redirectUri)) ||
      (shared && validSharedRedirect(redirectUri));
    if (!redirectUri || !validRedirect) {
      return oauthError(reply, 400, 'invalid_request', 'redirect_uri is not registered for this client');
    }

    const fail = (error: string, error_description: string) => redirectToClient(reply, redirectUri, { error, error_description, state: params.state ?? '' });

    if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    const scopeCheck = validateScopes(params.scope);
    if (!scopeCheck.ok) {
      const desc =
        scopeCheck.error === 'missing_openid'
          ? 'The openid scope is required'
          : scopeCheck.error === 'conflicting_profiles'
            ? 'Yggdrasil.PlayerProfiles.Select cannot be requested together with Yggdrasil.PlayerProfiles.Read'
            : 'Invalid scope';
      return fail('invalid_scope', desc);
    }
    if ((params.code_challenge || params.code_challenge_method) && (params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? ''))) {
      return fail('invalid_request', 'Only S256 code_challenge_method is supported');
    }
    if ((isPublicClient(client) || shared) && !params.code_challenge) return fail('invalid_request', 'Public clients must use S256 PKCE');
    if (params.prompt?.split(' ').includes('none')) return fail('consent_required', 'Interactive consent is required');

    const uid = crypto.randomUUID();
    await yggcUpsert('yggc_interactions', uid, {
      kind: 'authorize',
      params: {
        client_id: String(client.id),
        redirect_uri: redirectUri,
        scope: scopeCheck.scopes.join(' '),
        state: params.state ?? '',
        nonce: params.nonce ?? '',
        code_challenge: params.code_challenge ?? '',
      },
      createdAt: Math.floor(Date.now() / 1000),
    });
    return reply.redirect(`/connect/interaction/${uid}`);
  }});

  // --- Interaction UI -------------------------------------------------------
  app.get('/connect/interaction/:uid', async (request, reply) => renderInteraction(request, reply, (request.params as any).uid));

  app.post('/connect/interaction/:uid/confirm', async (request, reply) => replyAfterCommit(async () => {
    const { uid } = request.params as { uid: string };
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return async () => oauthError(reply, 403, 'access_denied', 'CSRF check failed');

    const record = await yggcFind('yggc_interactions', uid, true);
    if (!record) return async () => oauthError(reply, 404, 'invalid_request', 'Unknown interaction');
    const params = record.payload.params as Record<string, string>;

    const accountId = await currentUserUid(request);
    if (!accountId) return async () => reply.redirect(`/auth/login?redirect=${encodeURIComponent(`/connect/interaction/${uid}`)}`);
    const user = await findUserByUid(accountId);
    if (!user || user.permission === -1) return async () => oauthError(reply, 403, 'access_denied', 'The user is banned');

    const scopes = (params.scope ?? '').split(' ').filter(Boolean);

    // Profile binding for Yggdrasil.PlayerProfiles.Select (required by the spec)
    let selectedProfile: string | null = null;
    if (scopes.includes(SCOPES.PROFILE_SELECT)) {
      const input = String(body.selectedProfile ?? '').trim();
      const profiles = await availableProfilesOf(accountId);
      const byId = profiles.find((p) => p.id === input)?.id;
      const byName = input ? await getUuidByName(input) : null;
      const resolved = byId ?? (byName && profiles.some((p) => p.id === byName) ? byName : null);
      if (!resolved) {
        return async () => reply.view('error', { ...(await pageContext(request, '错误')), code: 400, message: '请选择一个属于你的角色后再授权。' });
      }
      selectedProfile = resolved;
    }

    const client = await findClient(params.client_id);
    if (!client) return async () => oauthError(reply, 400, 'invalid_request', 'Unknown client');

    // Confidential clients may reuse a previously persisted grant; public clients always re-consent.
    let grantId: string | null = null;
    if (!isPublicClient(client) && !record.payload.deviceCodeId) {
      const existing = await findExistingGrant(String(client.id), accountId, scopes);
      if (existing) grantId = existing.id;
    }
    if (!grantId) {
      grantId = await saveGrant(String(client.id), accountId, scopes);
    }

    if (record.payload.kind === 'device') {
      // Complete the device-flow authorization instead of redirecting.
      const deviceRecord = await yggcFind('yggc_device_codes', record.payload.deviceCodeId, true);
      if (!deviceRecord || deviceRecord.payload.status !== 'pending') {
        return async () => reply.view('error', { ...(await pageContext(request, '错误')), code: 400, message: '设备码已失效，请在启动器中重新发起授权。' });
      }
      await yggcUpsert(
        'yggc_device_codes',
        deviceRecord.id,
        {
          ...deviceRecord.payload,
          status: 'approved',
          accountId,
          selectedProfile,
          grantId,
        },
        deviceRecord.uid,
        false
      );
      await yggcDelete('yggc_interactions', uid);
      return async () => reply.view('yggc/device-done', { ...(await pageContext(request, '设备授权')), message: '授权成功，请回到启动器继续。你可以关闭此页面。' });
    }

    const code = crypto.randomBytes(24).toString('hex');
    await yggcUpsert('yggc_authorization_codes', code, {
      clientId: String(client.id),
      accountId,
      redirectUri: params.redirect_uri,
      scope: scopes,
      nonce: params.nonce ?? '',
      codeChallenge: params.code_challenge ?? '',
      grantId,
      selectedProfile,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    await yggcDelete('yggc_interactions', uid);

    const redirect: Record<string, string> = { code };
    if (params.state) redirect.state = params.state;
    return async () => redirectToClient(reply, params.redirect_uri, redirect);
  }));

  app.post('/connect/interaction/:uid/deny', async (request, reply) => replyAfterCommit(async () => {
    const { uid } = request.params as { uid: string };
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return async () => oauthError(reply, 403, 'access_denied', 'CSRF check failed');
    const record = await yggcFind('yggc_interactions', uid, true);
    if (!record) return async () => oauthError(reply, 404, 'invalid_request', 'Unknown interaction');
    const params = record.payload.params as Record<string, string>;
    await yggcDelete('yggc_interactions', uid);
    if (record.payload.kind === 'device') {
      const deviceRecord = await yggcFind('yggc_device_codes', record.payload.deviceCodeId, true);
      if (deviceRecord) {
        await yggcUpsert('yggc_device_codes', deviceRecord.id, { ...deviceRecord.payload, status: 'denied' }, deviceRecord.uid, false);
      }
      return async () => reply.view('yggc/device-done', { ...(await pageContext(request, '设备授权')), message: '已拒绝本次授权。' });
    }
    return async () => redirectToClient(reply, params.redirect_uri, { error: 'access_denied', error_description: 'The user denied the authorization request', state: params.state ?? '' });
  }));

  // --- Device flow ----------------------------------------------------------
  app.post('/connect/device_authorize', async (request, reply) => {
    reply.header('Cache-Control','no-store').header('Pragma','no-cache');
    const clientAuth = await authenticateClient(request);
    if ('error' in clientAuth) return clientAuthError(request,reply,clientAuth);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const scopeCheck = validateScopes(typeof body.scope === 'string' ? body.scope : '');
    if (!scopeCheck.ok) return oauthError(reply, 400, 'invalid_scope', 'Invalid scope');
    return createDeviceCode(String(clientAuth.client.id), scopeCheck.scopes);
  });

  app.get('/connect/device', async (request, reply) => {
    const query = request.query as Record<string, string>;
    return reply.view('yggc/device', {
      ...(await pageContext(request, '设备授权')),
      userCode: query.user_code ?? '',
      error: null,
      csrf: request.csrfToken(),
      loggedIn: !!(await currentUserUid(request)),
    });
  });

  app.post('/connect/device/link', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return oauthError(reply, 403, 'access_denied', 'CSRF check failed');
    const accountId = await currentUserUid(request);
    const code = String(body.user_code ?? '').trim().toUpperCase();
    if (!accountId) {
      return reply.redirect(`/auth/login?redirect=${encodeURIComponent(`/connect/device?user_code=${encodeURIComponent(code)}`)}`);
    }
    const deviceCode = await yggcFindByUserCode(code);
    if (!deviceCode || deviceCode.payload.status !== 'pending' || deviceCode.payload.expiresAt < Math.floor(Date.now() / 1000)) {
      return reply.view('yggc/device', {
        ...(await pageContext(request, '设备授权')),
        userCode: code,
        error: '设备码无效或已过期，请在启动器中重新发起授权。',
        csrf: request.csrfToken(),
        loggedIn: true,
      });
    }
    const uid = crypto.randomUUID();
    await yggcUpsert('yggc_interactions', uid, {
      kind: 'device',
      deviceCodeId: deviceCode.id,
      params: {
        client_id: deviceCode.payload.clientId,
        redirect_uri: '',
        scope: deviceCode.payload.scope,
        state: '',
        nonce: '',
        code_challenge: '',
      },
      createdAt: Math.floor(Date.now() / 1000),
    });
    return reply.redirect(`/connect/interaction/${uid}`);
  });

  // --- Token endpoint ---------------------------------------------------------
  app.post('/connect/token', async (request, reply) => replyAfterCommit(async () => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const grantType = String(body.grant_type ?? '');

    if (grantType === 'authorization_code') {
      const clientAuth = await authenticateClient(request);
      if ('error' in clientAuth) return async () => clientAuthError(request,reply,clientAuth);
      const code = String(body.code ?? '');
      const record = await yggcFind('yggc_authorization_codes', code, true);
      if (!record || record.consumed || record.payload.expiresAt < Math.floor(Date.now() / 1000)) {
        return async () => oauthError(reply, 400, 'invalid_grant', 'Invalid or expired authorization code');
      }
      if (record.payload.clientId !== String(clientAuth.client.id)) {
        return async () => oauthError(reply, 400, 'invalid_grant', 'The code was issued to another client');
      }
      if (String(body.redirect_uri ?? '') !== record.payload.redirectUri) {
        return async () => oauthError(reply, 400, 'invalid_grant', 'redirect_uri does not match');
      }
      if (record.payload.codeChallenge) {
        const ok = verifyPkce(record.payload.codeChallenge, typeof body.code_verifier === 'string' ? body.code_verifier : undefined);
        if (!ok) return async () => oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      }
      await yggcUpsert('yggc_authorization_codes', code, record.payload, record.uid, true);

      const scopes: string[] = record.payload.scope;
      const bundle = await issueTokenBundle(
        {
          clientId: String(clientAuth.client.id),
          accountId: record.payload.accountId,
          scopes,
          selectedProfile: record.payload.selectedProfile,
          grantId: record.payload.grantId,
          nonce: record.payload.nonce ?? null,
        },
        scopes.includes(SCOPES.OFFLINE_ACCESS)
      );
      return async () => tokenResponse(reply, bundle);
    }

    if (grantType === 'refresh_token') {
      const clientAuth = await authenticateClient(request);
      if ('error' in clientAuth) return async () => clientAuthError(request,reply,clientAuth);
      const refreshTokenId = String(body.refresh_token ?? '');
      const refresh = await findRefreshToken(refreshTokenId, true);
      if (!refresh || refresh.revoked || !refresh.expires_at || localStringToEpoch(refresh.expires_at) <= Date.now()) return async () => oauthError(reply, 400, 'invalid_grant', 'Invalid refresh token');
      const state = await yggcFind('yggc_refresh_tokens', refreshTokenId, true);
      if (!state || state.consumed) return async () => oauthError(reply, 400, 'invalid_grant', 'The refresh token is unavailable; sign in again');
      const associated = await loadTokenRow(refresh.access_token_id);
      if (!associated) return async () => oauthError(reply, 400, 'invalid_grant', 'The associated access token is no longer valid');
      if (associated.clientId !== String(clientAuth.client.id)) {
        return async () => oauthError(reply, 400, 'invalid_grant', 'The refresh token was issued to another client');
      }
      if (state.payload.clientId !== String(clientAuth.client.id) || Number(state.payload.accountId) !== associated.userId || state.payload.accessTokenId !== associated.jti) return async () => oauthError(reply, 400, 'invalid_grant', 'Invalid refresh token binding');
      const grant = state.payload.grantId ? await yggcFind('yggc_grants', state.payload.grantId) : null;
      if (state.payload.grantId && !grant) return async () => oauthError(reply, 400, 'invalid_grant', 'Authorization has been revoked or expired');
      let scopes = associated.scopes;
      if (body.scope !== undefined) {
        const narrowed = validateScopes(typeof body.scope === 'string' ? body.scope : '');
        if (!narrowed.ok || narrowed.scopes.some((s) => !scopes.includes(s))) return async () => oauthError(reply, 400, 'invalid_scope', 'Refresh scope may only narrow the original grant');
        scopes = narrowed.scopes;
      }

      // Rotate refresh token and revoke the old access token.
      await revokeRefreshToken(refreshTokenId);
      await revokeTokenRow(associated.jti);
      await yggcUpsert('yggc_refresh_tokens', state.id, state.payload, state.uid, true);
      const bundle = await issueTokenBundle(
        {
          clientId: String(associated.clientId),
          accountId: associated.userId,
          scopes,
          selectedProfile: scopes.includes(SCOPES.PROFILE_SELECT) ? state.payload.selectedProfile : null,
          grantId: state.payload.grantId ?? null,
        },
        scopes.includes(SCOPES.OFFLINE_ACCESS)
      );
      return async () => tokenResponse(reply, bundle);
    }

    if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
      const clientAuth = await authenticateClient(request);
      if ('error' in clientAuth) return async () => clientAuthError(request,reply,clientAuth);
      const deviceCodeId = String(body.device_code ?? '');
      const record = await yggcFind('yggc_device_codes', deviceCodeId, true);
      if (!record) return async () => oauthError(reply, 400, 'expired_token', 'The device code has expired or does not exist');
      const payload = record.payload;
      if (record.consumed) return async () => oauthError(reply, 400, 'expired_token', 'The device code has already been used');
      if (payload.expiresAt < Math.floor(Date.now() / 1000)) return async () => oauthError(reply, 400, 'expired_token', 'The device code has expired');
      if (payload.clientId !== String(clientAuth.client.id)) {
        return async () => oauthError(reply, 400, 'invalid_grant', 'The device code was issued to another client');
      }

      const now = Math.floor(Date.now() / 1000);
      const interval = payload.interval ?? 5;
      if (payload.lastPoll && now - payload.lastPoll < interval) {
        await yggcUpsert('yggc_device_codes', deviceCodeId, { ...payload, lastPoll: now, interval: interval + 5 }, record.uid, false);
        return async () => oauthError(reply, 400, 'slow_down', 'Polling too frequently');
      }
      await yggcUpsert('yggc_device_codes', deviceCodeId, { ...payload, lastPoll: now }, record.uid, false);

      if (payload.status === 'denied') return async () => oauthError(reply, 400, 'access_denied', 'The user denied the authorization request');
      if (payload.status !== 'approved' || !payload.accountId) {
        return async () => oauthError(reply, 400, 'authorization_pending', 'Waiting for the user to complete authorization');
      }

      await yggcUpsert('yggc_device_codes', deviceCodeId, payload, record.uid, true);
      const scopes: string[] = String(payload.scope ?? '').split(' ').filter(Boolean);
      const bundle = await issueTokenBundle(
        {
          clientId: String(clientAuth.client.id),
          accountId: payload.accountId,
          scopes,
          selectedProfile: payload.selectedProfile ?? null,
          grantId: payload.grantId ?? null,
        },
        scopes.includes(SCOPES.OFFLINE_ACCESS)
      );
      return async () => tokenResponse(reply, bundle);
    }

    return async () => oauthError(reply, 400, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token, device_code');
  }).catch((error) => {
    if (error instanceof TokenError) return oauthError(reply, 400, 'invalid_grant', error.message);
    throw error;
  }));

  app.post('/connect/revoke', async (request, reply) => replyAfterCommit(async () => {
    reply.header('Cache-Control', 'no-store');
    const authenticated = await authenticateClient(request);
    if ('error' in authenticated) return async () => clientAuthError(request,reply,authenticated);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = String(body.token ?? '');
    const refresh = await findRefreshToken(token, true);
    if (refresh) {
      const access = await loadTokenRow(refresh.access_token_id);
      if (access && access.clientId === String(authenticated.client.id)) await revokeTokenRow(access.jti);
    } else {
      const verified = await verifyAccessToken(token, { allowExpiredForRefresh: true });
      if (verified && String(verified.clientId) === String(authenticated.client.id)) await revokeTokenRow(verified.jti);
    }
    return async () => reply.code(200).send();
  }));

  // --- Userinfo -------------------------------------------------------------
  const userinfoHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control','no-store').header('Pragma','no-cache');
    const auth = String(request.headers['authorization'] ?? '');
    const body = request.body as Record<string,unknown> | undefined;
    const formToken = request.method === 'POST' && String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded') && typeof body?.access_token === 'string' ? body.access_token : null;
    if (auth && formToken) return oauthError(reply,400,'invalid_request','Use one bearer token transport');
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || formToken;
    if (!token) {
      reply.header('WWW-Authenticate', 'Bearer realm="openid"');
      return oauthError(reply, 401, 'invalid_token', 'A bearer token is required');
    }
    const verified: VerifiedToken | null = await verifyAccessToken(token);
    if (!verified) {
      reply.header('WWW-Authenticate', 'Bearer realm="openid" error="invalid_token"');
      return oauthError(reply, 401, 'invalid_token', 'The access token is invalid or expired');
    }
    if (!verified.scopes.includes(SCOPES.OPENID)) {
      reply.header('WWW-Authenticate', 'Bearer realm="openid" error="insufficient_scope"');
      return oauthError(reply, 403, 'insufficient_scope', 'The openid scope is required');
    }
    const info = await buildUserInfo({ userId: verified.userId, scopes: verified.scopes, selectedProfile: verified.selectedProfile });
    return { ...info, aud: String(verified.clientId) };
  };
  for(const url of ['/connect/userinfo','/userinfo','/yggc/userinfo']) app.route({method:['GET','POST'],url,handler:userinfoHandler});

  // Revoke a user's consent for a client (used by the user connections page)
  app.post('/connect/grants/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!request.checkCsrf(body.csrf)) return oauthError(reply, 403, 'access_denied', 'CSRF check failed');
    const accountId = await currentUserUid(request);
    if (!accountId) return oauthError(reply, 401, 'invalid_token', 'Login required');
    await revokeUserGrantsForClient(accountId, String(body.client_id ?? ''));
    return reply.redirect('/user/connections?notice=grant-revoked');
  });
}

async function isSharedClient(client: ClientInfo): Promise<boolean> {
  const shared = await getOption('ygg_shared_client_id', '');
  return !!shared && shared === String(client.id);
}

/** Native loopback callbacks may choose an ephemeral port (RFC 8252 §7.3). */
export function registeredRedirectMatches(registered: string, requested: string): boolean {
  if(registered===requested) return true;
  try {
    const expected=new URL(registered),actual=new URL(requested);
    return expected.protocol==='http:' && actual.protocol==='http:' &&
      ['127.0.0.1','[::1]','localhost'].includes(expected.hostname) && actual.hostname===expected.hostname &&
      !actual.username && !actual.password && !expected.username && !expected.password && !actual.hash && !expected.hash &&
      actual.pathname===expected.pathname && actual.search===expected.search;
  } catch {return false;}
}

export function validSharedRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

type TokenRowInfo = { jti: string; userId: number; clientId: string; scopes: string[]; clientToken: string | null; selectedProfile: string | null; row: any };
async function loadTokenRow(jti: string): Promise<TokenRowInfo | null> {
  const { queryOne } = await import('../db.js');
  const { safeParseScopes } = await import('../services/token.js');
  const row = await queryOne<any>('SELECT * FROM oauth_access_tokens WHERE id = ?', [jti]);
  if (!row || row.revoked) return null;
  const user = await findUserByUid(row.user_id);
  if (!user || user.permission === -1) return null;
  return {
    jti: row.id,
    userId: row.user_id,
    clientId: String(row.client_id),
    scopes: safeParseScopes(row.scopes),
    clientToken: null,
    selectedProfile: null,
    row,
  };
}

function tokenResponse(reply: FastifyReply, bundle: Awaited<ReturnType<typeof issueTokenBundle>>): FastifyReply {
  const resp: Record<string, any> = {
    token_type: 'Bearer',
    expires_in: bundle.access_token.expiresIn,
    access_token: bundle.access_token.jwt,
  };
  if (bundle.refresh_token) resp.refresh_token = bundle.refresh_token;
  if (bundle.id_token) resp.id_token = bundle.id_token;
  resp.scope = bundle.access_token.scopes.join(' ');
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  return reply.code(200).send(resp);
}
