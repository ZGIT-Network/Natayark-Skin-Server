import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';
import { getOption, getOptionBool } from './option.js';
import { getUuidByName, getNameByUuid } from './uuid.js';
import type { Player } from './player.js';
import { attachTextures, type PlayerWithName } from './player.js';
import type { Texture } from './texture.js';

/**
 * Yggdrasil profile serialization per the authlib-injector server spec.
 * Player UUIDs come from the `uuid` table (authoritative, includes real
 * Mojang UUIDs for verified players); user UUID = uuid5(NAMESPACE_DNS, email).
 */

export function userUuidFromEmail(email: string): string {
  return uuid5Dns(email.toLowerCase());
}
/** Blessing Skin's Yggdrasil plugin uses the immutable UID, not the mutable email. */
export function userUuidFromUid(uid: number): string { return uuid5Dns(String(uid)); }

function uuid5Dns(value: string): string {
  // RFC 4122 namespace DNS
  const ns = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(Buffer.from(value, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.subarray(0, 16).toString('hex');
}

export type YggProfile = {
  uuid: string;
  name: string;
  model: 'default' | 'slim';
  skinHash: string | null;
  capeHash: string | null;
  player: Player;
};

export async function profileFromPlayer(player: Player): Promise<YggProfile> {
  const [withTextures] = await attachTextures([player]);
  const uuid = (await getUuidByName(player.name)) ?? '';
  return {
    uuid,
    name: player.name,
    model: (withTextures.model as 'default' | 'slim') ?? 'default',
    skinHash: withTextures.skin?.hash ?? null,
    capeHash: withTextures.cape?.hash ?? null,
    player,
  };
}

export async function profileFromUuid(uuid: string): Promise<YggProfile | null> {
  const name = await getNameByUuid(uuid);
  if (!name) return null;
  const player = await queryOne<Player>('SELECT * FROM players WHERE name = ? LIMIT 1', [name]);
  if (!player) return null;
  return profileFromPlayer(player);
}

/** availableProfiles of a user (id + name only). */
export async function availableProfilesOf(uid: number): Promise<Array<{ id: string; name: string }>> {
  const { listPlayersOfUser } = await import('./player.js');
  const players = await listPlayersOfUser(uid);
  const profiles: Array<{ id: string; name: string }> = [];
  for (const player of players) {
    const uuid = await getUuidByName(player.name);
    if (uuid) profiles.push({ id: uuid, name: player.name });
  }
  return profiles;
}

async function fetchMojangProfile(uuid: string): Promise<{ SKIN?: any; CAPE?: any } | null> {
  const key = `mojang_profile_${uuid}`;
  const { cacheGet, cachePut } = await import('./cache.js');
  const cached = cacheGet<any>(key);
  if (cached !== undefined) return cached;
  try {
    const resp = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      cachePut(key, null, 300);
      return null;
    }
    const body: any = await resp.json();
    const property = body?.properties?.find((p: any) => p.name === 'textures');
    if (!property) {
      cachePut(key, null, 300);
      return null;
    }
    const textures = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')).textures ?? {};
    cachePut(key, textures, 300);
    return textures;
  } catch {
    cachePut(key, null, 60);
    return null;
  }
}

async function isMojangVerifiedUuid(uuid: string): Promise<boolean> {
  const row = await queryOne('SELECT 1 FROM mojang_verifications WHERE uuid = ? AND verified = 1 LIMIT 1', [uuid]);
  return !!row;
}

/** Build the textures property value (base64 encoded payload). */
export async function serializeTexturesProperty(profile: YggProfile, unsigned: boolean): Promise<{ value: string; signature?: Buffer }> {
  const textures: any = {
    timestamp: Date.now(),
    profileId: profile.uuid,
    profileName: profile.name,
    isPublic: true,
    textures: {},
  };
  if (!unsigned) textures.signatureRequired = true;

  const useMojangFallback = (profile.skinHash === null || profile.capeHash === null) && (await isMojangVerifiedUuid(profile.uuid));

  if (profile.skinHash) {
    const skin: any = { url: new URL(`/textures/${profile.skinHash}`, await siteUrl()).toString() };
    if (profile.model === 'slim') skin.metadata = { model: 'slim' };
    textures.textures.SKIN = skin;
  } else if (useMojangFallback) {
    const mojang = await fetchMojangProfile(profile.uuid);
    if (mojang?.SKIN) textures.textures.SKIN = mojang.SKIN;
  }

  if (profile.capeHash) {
    textures.textures.CAPE = { url: new URL(`/textures/${profile.capeHash}`, await siteUrl()).toString() };
  } else if (useMojangFallback) {
    const mojang = await fetchMojangProfile(profile.uuid);
    if (mojang?.CAPE) textures.textures.CAPE = mojang.CAPE;
  }

  const value = Buffer.from(JSON.stringify(textures), 'utf8').toString('base64');
  if (unsigned) return { value };

  const privateKeyPem = (await getOption('ygg_private_key')) ?? '';
  if (!privateKeyPem) throw new Error('ygg_private_key is not configured');
  const signature = crypto.sign('sha1', Buffer.from(value), crypto.createPrivateKey(privateKeyPem));
  return { value, signature };
}

async function siteUrl(): Promise<string> {
  return (await getOption('site_url', 'http://localhost:3000')).replace(/\/+$/, '');
}

/** Full profile response for GET profile/{uuid} etc. */
export async function serializeProfile(profile: YggProfile, unsigned: boolean): Promise<Record<string, any>> {
  const { value, signature } = await serializeTexturesProperty(profile, unsigned);
  const properties: Array<Record<string, any>> = [{ name: 'textures', value }, { name: 'uploadableTextures', value: 'skin,cape' }];
  if (signature) properties[0].signature = signature.toString('base64');
  if (!unsigned) {
    const key = crypto.createPrivateKey((await getOption('ygg_private_key')) ?? '');
    properties[1].signature = crypto.sign('sha1', Buffer.from(properties[1].value), key).toString('base64');
  }
  return { id: profile.uuid, name: profile.name, properties };
}

/** Does this user have a mojang verification row (for join-with-mojang-token)? */
export async function isMojangVerifiedUser(uid: number): Promise<boolean> {
  const row = await queryOne('SELECT 1 FROM mojang_verifications WHERE user_id = ? AND verified = 1 LIMIT 1', [uid]);
  return !!row;
}

/** Validate an access token against Mojang's authserver. */
export async function validateMojangToken(accessToken: string): Promise<boolean> {
  try {
    const resp = await fetch('https://authserver.mojang.com/validate', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    return resp.status === 204;
  } catch {
    return false;
  }
}
