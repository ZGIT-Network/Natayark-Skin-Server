import type { FastifyInstance } from 'fastify';
import { queryOne, nowDate, exec, withTransaction } from '../db.js';
import { getOption, getOptionInt, getOptionBool } from '../services/option.js';
import {
  findUserByUid,
  findUserByEmail,
  checkUserPassword,
  PERMISSION_BANNED,
  type User,
} from '../services/user.js';
import { findPlayerByName, attachTextures, type Player } from '../services/player.js';
import { getUuidByName, getNameByUuid } from '../services/uuid.js';
import {
  userUuidFromEmail,
  userUuidFromUid,
  profileFromPlayer,
  profileFromUuid,
  availableProfilesOf,
  serializeProfile,
  serializeTexturesProperty,
  isMojangVerifiedUser,
  validateMojangToken,
} from '../services/profile.js';
import {
  getSystemClientId,
  verifyAccessToken,
  issueAccessToken,
  revokeTokenRow,
  revokeAllTokensForUser,
  isRefreshable,
  SCOPES,
  type VerifiedToken,
} from '../services/token.js';
import { cacheGet, cachePut } from '../services/cache.js';
import { yggLog } from '../services/ygglog.js';
import { randomHex, uuid4Hex } from '../util.js';
import { issuer } from '../services/oidc.js';
import { uploadTextureDirect } from './helpers.js';

// ---------------------------------------------------------------------------
// Yggdrasil error responses: { error, errorMessage }

export class YggdrasilError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string
  ) {
    super(message);
  }
}

export const illegalArgument = (msg: string) => new YggdrasilError(400, 'IllegalArgumentException', msg);
export const forbiddenOperation = (msg: string) => new YggdrasilError(403, 'ForbiddenOperationException', msg);
export const notFound = (msg: string) => new YggdrasilError(404, 'NotFoundException', msg);

async function serverName(): Promise<string> {
  return (await getOption('site_name', 'Minecraft Skin Station')).replace(/\/+$/, '');
}

async function skinDomains(): Promise<string[]> {
  const custom = await getOption('ygg_skin_domain');
  if (custom) {
    return custom.split(',').map((d) => d.trim()).filter(Boolean);
  }
  try {
    const host = new URL(await getOption('site_url', 'http://localhost:3000')).hostname;
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];
    return [host, `*.${host}`];
  } catch {
    return ['localhost'];
  }
}

/** GET /api/yggdrasil — API metadata for authlib-injector. */
export async function yggdrasilMetadata(): Promise<Record<string, any>> {
  const publicKeyPem = (await getOption('ygg_private_key')) ?? '';
  let publicKey = '';
  if (publicKeyPem) {
    try {
      const crypto = await import('node:crypto');
      publicKey = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' }).toString();
    } catch {
      publicKey = '';
    }
  }
  const meta: Record<string, any> = {
    meta: {
      serverName: await serverName(),
      implementationName: 'Natayark SkinServer',
      implementationVersion: '1.0.0',
      links: { homepage: await getOption('site_url', '/'), register: `${await getOption('site_url', '')}/auth/register` },
      'feature.non_email_login': !(await getOptionBool('ygg_disable_authserver', false)),
      'feature.openid_configuration_url': `${await issuer()}/.well-known/openid-configuration`,
      'feature.enable_profile_key': false,
    },
    skinDomains: await skinDomains(),
  };
  if (publicKey) meta.signaturePublickey = publicKey;
  // Yggdrasil Connect discovery (feature of the new spec)
  return meta;
}

async function requireJsonBody(request: any): Promise<any> {
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    throw illegalArgument('Content-Type must be application/json');
  }
  return request.body ?? {};
}

async function loadUserForAuthentication(identification: string, password: string): Promise<User> {
  if (!identification || !password) {
    throw illegalArgument('credentials are required');
  }
  let user: User | null;
  if (identification.includes('@')) {
    user = await findUserByEmail(identification);
  } else {
    const player = await findPlayerByName(identification);
    user = player ? await findUserByUid(player.uid) : null;
  }
  if (!user || !checkUserPassword(user, password)) throw forbiddenOperation('Invalid credentials. Invalid username or password.');
  if (user.permission === PERMISSION_BANNED) throw forbiddenOperation('The user has been banned');
  if ((await getOptionBool('require_verification', false)) && user.verified !== 1) {
    throw forbiddenOperation('The user has not been verified');
  }
  return user;
}

// ---------------------------------------------------------------------------

export async function registerYggdrasilRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/yggdrasil/authserver/') && await getOptionBool('ygg_disable_authserver', false)) throw forbiddenOperation('Password authentication is disabled. Use Yggdrasil Connect.');
  });
  // --- API metadata ------------------------------------------------------
  app.get('/api/yggdrasil', async () => yggdrasilMetadata());
  app.get('/api/yggdrasil/', async () => yggdrasilMetadata());
  const publicKeys = async () => {
    const crypto = await import('node:crypto');
    const pem = await getOption('ygg_private_key');
    if (!pem) throw illegalArgument('Texture signing key is not configured');
    const publicKey = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
    return { profilePropertyKeys: [{ publicKey }], playerCertificateKeys: [] };
  };
  app.get('/minecraftservices/publickeys', publicKeys);
  app.get('/api/yggdrasil/minecraftservices/publickeys', publicKeys);

  // --- Authserver --------------------------------------------------------
  const passwordRateLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (request: any) => String(request.body?.username ?? request.ip).toLowerCase() } } };
  app.post('/api/yggdrasil/authserver/authenticate', passwordRateLimit, async (request, reply) => {
    const body = await requireJsonBody(request);
    const user = await loadUserForAuthentication(String(body.username ?? ''), String(body.password ?? ''));
    const email = user.email;
    const userUuid = userUuidFromUid(user.uid);
    if (body.clientToken !== undefined && typeof body.clientToken !== 'string') throw illegalArgument('clientToken must be a string');
    const clientToken = typeof body.clientToken === 'string' ? body.clientToken : uuid4Hex();

    const profiles = await availableProfilesOf(user.uid);

    // Login by player name binds the token to that player (Yggdrasil Connect plugin behaviour).
    let selectedProfile: string | null = null;
    if (!String(body.username ?? '').includes('@')) {
      const uuid = await getUuidByName(String(body.username));
      if (uuid && profiles.some((p) => p.id === uuid)) selectedProfile = uuid;
    }
    if (!selectedProfile && profiles.length === 1) selectedProfile = profiles[0].id;

    const clientId = await getSystemClientId();
    const issued = await issueAccessToken({
      userId: user.uid,
      clientId,
      scopes: [SCOPES.PROFILE_SELECT, SCOPES.SERVER_JOIN],
      clientToken,
      selectedProfile,
    });

    const resp: Record<string, any> = {
      accessToken: issued.jwt,
      clientToken,
      availableProfiles: selectedProfile ? profiles.filter((p) => p.id === selectedProfile) : profiles,
    };
    if (selectedProfile) {
      resp.selectedProfile = profiles.find((p) => p.id === selectedProfile);
    }
    if (body.requestUser) {
      resp.user = { id: userUuid, properties: [] };
    }

    await yggLog({ action: 'authenticate', user_id: user.uid, parameters: { ...body, username: undefined, password: undefined }, ip: request.ip });
    return reply.code(200).send(resp);
  });

  app.post('/api/yggdrasil/authserver/refresh', async (request, reply) => withTransaction(async () => {
    const body = await requireJsonBody(request);
    const accessToken = String(body.accessToken ?? '');
    const clientToken = body.clientToken ? String(body.clientToken) : null;

    const verified = await verifyAccessToken(accessToken, { allowExpiredForRefresh: true });
    if (!verified) throw forbiddenOperation('Invalid token.');
    if (verified.scopes.includes(SCOPES.OPENID) || !verified.scopes.includes(SCOPES.SERVER_JOIN) || verified.grantId) throw forbiddenOperation('Use the OAuth token endpoint to refresh this token.');
    const locked = await queryOne<{ revoked: number }>('SELECT revoked FROM oauth_access_tokens WHERE id = ? FOR UPDATE', [verified.jti]);
    if (!locked || locked.revoked) throw forbiddenOperation('Invalid token.');
    if (!verified.row || !(await isRefreshable(verified.row))) {
      throw forbiddenOperation('Invalid token.');
    }
    if (body.clientToken !== undefined && verified.clientToken !== null && String(body.clientToken) !== verified.clientToken) {
      throw forbiddenOperation('Client token does not match.');
    }

    const user = await findUserByUid(verified.userId);
    if (!user) throw forbiddenOperation('The user does not exist anymore');
    if (user.permission === PERMISSION_BANNED) throw forbiddenOperation('The user has been banned');

    const profiles = await availableProfilesOf(user.uid);
    let selectedProfile = verified.selectedProfile;

    if (body.selectedProfile) {
      if (selectedProfile) throw illegalArgument('Access token already has a profile assigned.');
      const requested = body.selectedProfile;
      const requestedId = typeof requested === 'object' ? String(requested.id ?? '') : String(requested ?? '');
      const requestedName = typeof requested === 'object' ? String(requested.name ?? '') : '';
      const profile = profiles.find((p) => p.id === requestedId || (requestedName && p.name === requestedName));
      if (!profile) throw illegalArgument('The requested profile does not exist or does not belong to this user');
      if (selectedProfile && selectedProfile !== profile.id) {
        throw illegalArgument('The requested profile does not match the bound profile of this token');
      }
      selectedProfile = profile.id;
    } else if (selectedProfile && !profiles.some((p) => p.id === selectedProfile)) {
      selectedProfile = null;
    }

    // Rotate: revoke the old token, issue a fresh one.
    await revokeTokenRow(verified.jti);
    const clientId = verified.clientId;
    const issued = await issueAccessToken({
      userId: user.uid,
      clientId,
      scopes: verified.scopes,
      clientToken: verified.clientToken ?? undefined,
      selectedProfile,
    });

    const resp: Record<string, any> = {
      accessToken: issued.jwt,
      clientToken: verified.clientToken ?? '',
      availableProfiles: selectedProfile ? profiles.filter((p) => p.id === selectedProfile) : profiles,
    };
    if (selectedProfile) resp.selectedProfile = profiles.find((p) => p.id === selectedProfile);
    if (body.requestUser) {
      resp.user = { id: userUuidFromUid(user.uid), properties: [] };
    }
    await yggLog({ action: 'refresh', user_id: user.uid, ip: request.ip });
    return reply.code(200).send(resp);
  }));

  app.post('/api/yggdrasil/authserver/validate', async (request, reply) => {
    const body = await requireJsonBody(request);
    const verified = await verifyAccessToken(String(body.accessToken ?? ''));
    if (!verified) throw forbiddenOperation('Invalid token.');
    if (body.clientToken !== undefined && verified.clientToken !== null && String(body.clientToken) !== verified.clientToken) {
      throw forbiddenOperation('Client token does not match.');
    }
    return reply.code(204).send();
  });

  app.post('/api/yggdrasil/authserver/invalidate', async (request, reply) => {
    try {
      const body = await requireJsonBody(request);
      if (body.accessToken) {
        const verified = await verifyAccessToken(String(body.accessToken));
        if (verified) await revokeTokenRow(verified.jti);
      }
    } catch {
      // per spec, always respond 204
    }
    await yggLog({ action: 'invalidate', ip: request.ip });
    return reply.code(204).send();
  });

  app.post('/api/yggdrasil/authserver/signout', passwordRateLimit, async (request, reply) => {
    const body = await requireJsonBody(request);
    const user = await loadUserForAuthentication(String(body.username ?? ''), String(body.password ?? ''));
    await revokeAllTokensForUser(user.uid);
    await yggLog({ action: 'signout', user_id: user.uid, ip: request.ip });
    return reply.code(204).send();
  });

  // --- Session server ----------------------------------------------------
  app.post('/api/yggdrasil/sessionserver/session/minecraft/join', async (request, reply) => {
    const body = await requireJsonBody(request);
    const accessToken = String(body.accessToken ?? '');
    const selectedProfile = String(body.selectedProfile ?? '');
    const serverId = String(body.serverId ?? '');
    if (!serverId || serverId.length > 255 || !/^[0-9a-f]{32}$/i.test(selectedProfile)) throw illegalArgument('Invalid session parameters');

    const verified = await verifyAccessToken(accessToken);
    if (!verified) throw forbiddenOperation('Invalid token.');
    if (verified.row && !(await isRefreshable(verified.row))) throw forbiddenOperation('Invalid token.');

    const name = await getNameByUuid(selectedProfile);
    if (!name) throw forbiddenOperation(`The profile ${selectedProfile} does not exist`);
    const player = await findPlayerByName(name);
    if (!player) throw forbiddenOperation(`The profile ${selectedProfile} does not exist`);

    const user = await findUserByUid(player.uid);
    if (!user || user.permission === PERMISSION_BANNED) throw forbiddenOperation('The user has been banned');

    const joinScopeOk = verified.scopes.includes(SCOPES.SERVER_JOIN);
    if (!joinScopeOk) throw forbiddenOperation('The access token lacks the required scope to join servers');

    if (!verified.selectedProfile || verified.selectedProfile !== selectedProfile) {
      throw forbiddenOperation('The access token is bound to a different profile');
    }
    // Tokens without profile binding (classic flow with multiple profiles) must still own the profile.
    if (player.uid !== verified.userId) {
      throw forbiddenOperation('The access token is not owned by the profile owner');
    }

    cachePut(`ygg_server_${serverId}_${selectedProfile}`, { profile: selectedProfile, name, ip: request.ip, accessToken }, 30);
    await yggLog({ action: 'join', user_id: user.uid, player_id: player.pid, parameters: { serverId }, ip: request.ip });
    return reply.code(204).send();
  });

  app.get('/api/yggdrasil/sessionserver/session/minecraft/hasJoined', async (request, reply) => {
    const { username, serverId, ip } = request.query as Record<string, string | undefined>;
    if (!username || !serverId) return reply.code(400).send();
    const uuid = await getUuidByName(username);
    if (!uuid) return reply.code(204).send();
    const session = cacheGet<{ profile: string; name: string; ip: string; accessToken: string }>(`ygg_server_${serverId}_${uuid}`);
    if (!session) return reply.code(204).send();
    if (!(await verifyAccessToken(session.accessToken))) return reply.code(204).send();
    if (ip && session.ip && ip !== session.ip) return reply.code(204).send();

    const profile = await profileFromUuid(session.profile);
    if (!profile || profile.name !== username) return reply.code(204).send();

    const serialized = await serializeProfile(profile, false);
    await yggLog({ action: 'has_joined', user_id: profile.player.uid, player_id: profile.player.pid, ip: request.ip });
    return reply.code(200).header('Content-Type', 'application/json').send(serialized);
  });

  app.get('/api/yggdrasil/sessionserver/session/minecraft/profile/:uuid', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const query = request.query as Record<string, string | undefined>;
    const unsigned = query.unsigned === undefined ? true : query.unsigned !== 'false';

    const profile = await profileFromUuid(uuid);
    if (!profile) return reply.code(204).send();

    const banned = await queryOne('SELECT 1 FROM users WHERE uid = ? AND permission = -1', [profile.player.uid]);
    if (banned) return reply.code(204).send();

    const serialized = await serializeProfile(profile, unsigned);
    return reply.code(200).send(serialized);
  });

  // --- Profile lookups ---------------------------------------------------
  app.post('/api/yggdrasil/api/profiles/minecraft', async (request, reply) => {
    const body = request.body;
    if (!Array.isArray(body)) throw illegalArgument('Request body must be an array of player names');
    const max = Math.max(2, await getOptionInt('ygg_search_profile_max', 5));
    if (body.length > max || body.some((x) => typeof x !== 'string')) throw illegalArgument('Too many profiles or invalid names');
    const names = [...new Set(body.map(String))].slice(0, max);

    const profiles: Array<{ id: string; name: string }> = [];
    for (const name of names) {
      const player = await findPlayerByName(name);
      if (!player) continue;
      const uuid = await getUuidByName(player.name);
      if (uuid) profiles.push({ id: uuid, name: player.name });
    }
    return profiles;
  });

  const singleLookup = async (request: any, reply: any) => {
    const { username } = request.params as { username: string };
    const player = await findPlayerByName(username);
    if (!player) return reply.code(204).send();
    const uuid = await getUuidByName(player.name);
    if (!uuid) return reply.code(204).send();
    return { id: uuid, name: player.name };
  };
  app.get('/api/yggdrasil/api/users/profiles/minecraft/:username', singleLookup);
  // minecraftservices aliases (new spec)
  app.get('/minecraftservices/minecraft/profile/lookup/name/:username', singleLookup);
  app.get('/api/yggdrasil/minecraftservices/minecraft/profile/lookup/name/:username', singleLookup);
  app.get('/api/yggdrasil/api/minecraft/profile/lookup/name/:username', singleLookup);
  const bulkLookup = async (request: any, reply: any) => {
    const body = request.body;
    if (!Array.isArray(body)) throw illegalArgument('Request body must be an array of player names');
    const max = Math.max(2, await getOptionInt('ygg_search_profile_max', 5));
    if (body.length > max || body.some((x: unknown) => typeof x !== 'string')) throw illegalArgument('Too many profiles or invalid names');
    const names = [...new Set(body.map((n: any) => String(n)))].slice(0, max);
    const profiles: Array<{ id: string; name: string }> = [];
    for (const name of names) {
      const player = await findPlayerByName(name);
      if (!player) continue;
      const uuid = await getUuidByName(player.name);
      if (uuid) profiles.push({ id: uuid, name: player.name });
    }
    return profiles;
  };
  app.post('/minecraftservices/minecraft/profile/lookup/bulk/byname', bulkLookup);
  app.post('/api/yggdrasil/minecraftservices/minecraft/profile/lookup/bulk/byname', bulkLookup);
  app.post('/api/yggdrasil/api/minecraft/profile/lookup/bulk/byname', bulkLookup);

  // --- Texture upload via Bearer token ------------------------------------
  app.put('/api/yggdrasil/api/user/profile/:uuid/:type', async (request, reply) => {
    const { uuid, type } = request.params as { uuid: string; type: string };
    if (!['skin', 'cape'].includes(type)) throw illegalArgument('Texture type must be skin or cape');

    const auth = String(request.headers['authorization'] ?? '');
    if (!auth.startsWith('Bearer ')) throw new YggdrasilError(401, 'UnauthorizedException', 'A bearer token is required');
    const verified: VerifiedToken | null = await verifyAccessToken(auth.slice(7).trim());
    if (!verified) throw new YggdrasilError(401, 'UnauthorizedException', 'Invalid token.');

    const profile = await profileFromUuid(uuid);
    if (!profile) throw illegalArgument(`The profile ${uuid} does not exist`);
    if (profile.player.uid !== verified.userId) throw forbiddenOperation('The profile does not belong to the token owner');
    if (!verified.scopes.includes(SCOPES.SERVER_JOIN) || verified.selectedProfile !== uuid) {
      throw forbiddenOperation('The access token is bound to a different profile');
    }

    await uploadTextureDirect(request, reply, profile.player, type as 'skin' | 'cape');
  });

  app.delete('/api/yggdrasil/api/user/profile/:uuid/:type', async (request, reply) => {
    const { uuid, type } = request.params as { uuid: string; type: string };
    if (!['skin', 'cape'].includes(type)) throw illegalArgument('Texture type must be skin or cape');

    const auth = String(request.headers['authorization'] ?? '');
    if (!auth.startsWith('Bearer ')) throw new YggdrasilError(401, 'UnauthorizedException', 'A bearer token is required');
    const verified = await verifyAccessToken(auth.slice(7).trim());
    if (!verified) throw new YggdrasilError(401, 'UnauthorizedException', 'Invalid token.');

    const profile = await profileFromUuid(uuid);
    if (!profile) throw illegalArgument(`The profile ${uuid} does not exist`);
    if (profile.player.uid !== verified.userId) throw forbiddenOperation('The profile does not belong to the token owner');
    if (!verified.scopes.includes(SCOPES.SERVER_JOIN) || verified.selectedProfile !== uuid) throw forbiddenOperation('The access token is not bound to this profile');

    const { clearPlayerTexture } = await import('../services/player.js');
    await clearPlayerTexture(profile.player, type as 'skin' | 'cape');
    await yggLog({ action: 'reset_texture', user_id: verified.userId, player_id: profile.player.pid, parameters: { type }, ip: request.ip });
    return reply.code(204).send();
  });
}
