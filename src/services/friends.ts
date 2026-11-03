import { exec, query, queryOne, withTransaction, nowString } from '../db.js';
import { findPlayerByName } from './player.js';
import { profileFromPlayer, profileFromUuid, type YggProfile } from './profile.js';
import { normalizeUuid } from './uuid.js';

export class FriendsError extends Error {
  constructor(public statusCode: number, public status: string, message: string) { super(message); }
}
export type SocialProfile = {
  profile_id: string; player_id: number; friends_enabled: number; accept_invites: number;
  profanity_filter: number; presence_status: string; last_seen: number | null; presence_token: string | null;
};
type Relationship = { profile_low: string; profile_high: string; requested_by: string; accepted: number };
export const PRESENCE_TTL_MS = 120_000;
export const PRESENCE_STATUSES = ['ONLINE','PLAYING_OFFLINE','PLAYING_REALMS','PLAYING_SERVER','PLAYING_HOSTED_SERVER','OFFLINE'] as const;
export type PresenceStatus = typeof PRESENCE_STATUSES[number];

export async function socialStorageReady(): Promise<boolean> {
  try { await query('SELECT profile_id FROM mcn_social_profiles LIMIT 0'); await query('SELECT profile_low FROM mcn_friendships LIMIT 0'); return true; }
  catch (error) { if ((error as any).code === 'ER_NO_SUCH_TABLE') return false; throw error; }
}

/** Lock characters in a consistent order before creating or changing social state. */
async function prepare(profiles: YggProfile[]): Promise<void> {
  const ordered = [...new Map(profiles.map(profile => [profile.player.pid, profile])).values()].sort((a,b) => a.player.pid-b.player.pid);
  for (const profile of ordered) {
    const player = await queryOne<{pid:number}>('SELECT pid FROM players WHERE pid=? AND uid=? FOR UPDATE', [profile.player.pid,profile.player.uid]);
    if (!player) throw new FriendsError(400,'UNKNOWN_PROFILE','Name or profile does not exist');
    // A UUID replacement is a new social identity; never inherit the old identity's contacts.
    await exec('DELETE FROM mcn_social_profiles WHERE player_id=? AND profile_id<>?', [profile.player.pid,profile.uuid]);
    await exec('INSERT INTO mcn_social_profiles (profile_id,player_id) VALUES (?,?) ON DUPLICATE KEY UPDATE profile_id=profile_id', [profile.uuid,profile.player.pid]);
    const row = await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=? FOR UPDATE',[profile.uuid]);
    if (!row || row.player_id !== profile.player.pid) throw new FriendsError(400,'DUPLICATED_PROFILES','Profile identity is ambiguous');
  }
}
export async function socialPreferences(profile: YggProfile): Promise<SocialProfile> {
  return withTransaction(async () => { await prepare([profile]); return (await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=?',[profile.uuid]))!; });
}
export async function updateSocialPreferences(profile: YggProfile, changes: { friends?: boolean; acceptInvites?: boolean; profanityFilter?: boolean }): Promise<SocialProfile> {
  return withTransaction(async () => {
    await prepare([profile]);
    const current = (await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=? FOR UPDATE',[profile.uuid]))!;
    const enabled = changes.friends ?? !!current.friends_enabled;
    await exec('UPDATE mcn_social_profiles SET friends_enabled=?,accept_invites=?,profanity_filter=?,presence_status=IF(?,presence_status,\'OFFLINE\'),presence_token=IF(?,presence_token,NULL) WHERE profile_id=?',
      [Number(enabled),Number(changes.acceptInvites ?? !!current.accept_invites),Number(changes.profanityFilter ?? !!current.profanity_filter),enabled,enabled,profile.uuid]);
    return (await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=?',[profile.uuid]))!;
  });
}

/** Resolve names on each read, so renames stay visible and replaced/deleted UUIDs do not leak. */
async function contacts(profileId: string) {
  return query<SocialProfile & {name:string;uid:number;accepted:number;requested_by:string}>(
    `SELECT s.*,p.name,p.uid,f.accepted,f.requested_by FROM mcn_friendships f
     JOIN mcn_social_profiles s ON s.profile_id=IF(f.profile_low=?,f.profile_high,f.profile_low)
     JOIN players p ON p.pid=s.player_id JOIN users u ON u.uid=p.uid
     WHERE (f.profile_low=? OR f.profile_high=?) AND u.permission<>-1
       AND EXISTS (SELECT 1 FROM \`uuid\` v WHERE v.name=p.name AND LOWER(REPLACE(v.uuid,'-',''))=s.profile_id)
     ORDER BY s.profile_id`,[profileId,profileId,profileId]);
}
export async function friendsList(profile: YggProfile) {
  await socialPreferences(profile);
  const rows = await contacts(profile.uuid);
  const result: {friends:Array<{profileId:string;name:string}>;incomingRequests:Array<{profileId:string;name:string}>;outgoingRequests:Array<{profileId:string;name:string}>} = {friends:[],incomingRequests:[],outgoingRequests:[]};
  for (const row of rows) {
    const key = row.accepted ? 'friends' : row.requested_by === profile.uuid ? 'outgoingRequests' : 'incomingRequests';
    result[key].push({profileId:row.profile_id,name:row.name});
  }
  return result;
}
export async function friendTarget(input: {name?:string;profileId?:string}): Promise<YggProfile> {
  let profile: YggProfile | null = null;
  if (input.profileId !== undefined) {
    if (!/^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(input.profileId)) throw new FriendsError(400,'INVALID_JSON','Invalid profileId');
    profile = await profileFromUuid(normalizeUuid(input.profileId)!);
  } else if (input.name) {
    const player = await findPlayerByName(input.name);
    if (player) profile = await profileFromPlayer(player);
  }
  const user = profile && await queryOne<{permission:number}>('SELECT permission FROM users WHERE uid=?',[profile.player.uid]);
  if (!profile?.uuid || !user || user.permission === -1) throw new FriendsError(400,'UNKNOWN_PROFILE','Name or profile does not exist');
  return profile;
}
export async function updateFriend(profile: YggProfile, target: YggProfile, action: 'ADD' | 'REMOVE'): Promise<void> {
  if (profile.uuid === target.uuid) throw new FriendsError(400,'CANNOT_ADD_SELF','Cannot add yourself as friend');
  await withTransaction(async () => {
    await prepare([profile,target]);
    const [low,high] = [profile.uuid,target.uuid].sort();
    const relationship = await queryOne<Relationship>('SELECT * FROM mcn_friendships WHERE profile_low=? AND profile_high=? FOR UPDATE',[low,high]);
    if (action === 'REMOVE') {
      if (!relationship) throw new FriendsError(400,'NOT_FRIENDS','No friendship or request exists');
      await exec('DELETE FROM mcn_friendships WHERE profile_low=? AND profile_high=?',[low,high]);
      return;
    }
    const own = (await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=?',[profile.uuid]))!;
    const other = (await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=?',[target.uuid]))!;
    if (!own.friends_enabled || !other.friends_enabled || (!relationship && !other.accept_invites)) throw new FriendsError(403,'INVITE_REJECTED','User does not have friends enabled or accept invites');
    if (relationship?.accepted) throw new FriendsError(400,'ALREADY_FRIENDS','Already friends');
    if (relationship) {
      if (relationship.requested_by !== profile.uuid) await exec('UPDATE mcn_friendships SET accepted=1 WHERE profile_low=? AND profile_high=?',[low,high]);
      return;
    }
    for (const id of [profile.uuid,target.uuid]) {
      const count = await queryOne<{total:number}>('SELECT COUNT(*) AS total FROM mcn_friendships WHERE profile_low=? OR profile_high=?',[id,id]);
      if (Number(count?.total) >= 1000) throw new FriendsError(429,'TOO_MANY_REQUESTS','Friend and request limit reached');
    }
    await exec('INSERT INTO mcn_friendships (profile_low,profile_high,requested_by,accepted,created_at) VALUES (?,?,?,0,?)',[low,high,profile.uuid,Date.now()]);
  });
}

export async function presence(profile: YggProfile, tokenId: string, status: PresenceStatus) {
  const own = await withTransaction(async () => {
    await prepare([profile]);
    const preferences = (await queryOne<SocialProfile>('SELECT * FROM mcn_social_profiles WHERE profile_id=?',[profile.uuid]))!;
    await exec('UPDATE mcn_social_profiles SET presence_status=?,last_seen=?,presence_token=? WHERE profile_id=?',[preferences.friends_enabled?status:'OFFLINE',Date.now(),tokenId,profile.uuid]);
    return preferences;
  });
  if (!own.friends_enabled) return {presence:[]};
  const rows = (await contacts(profile.uuid)).filter(row => row.accepted);
  const recent=rows.filter(row=>row.presence_token&&row.friends_enabled&&row.last_seen&&Number(row.last_seen)>Date.now()-PRESENCE_TTL_MS);
  const activeTokens=recent.length?await query<{id:string;user_id:number}>(
    `SELECT a.id,a.user_id FROM oauth_access_tokens a JOIN oauth_clients c ON c.id=a.client_id
     WHERE a.id IN (${recent.map(()=>'?').join(',')}) AND a.revoked=0 AND c.revoked=0 AND a.expires_at>?`,[...recent.map(row=>row.presence_token),nowString()]):[];
  const activeIds=new Set(activeTokens.map(token=>token.id+':'+token.user_id));
  const result = [];
  for (const row of rows) {
    const active = row.friends_enabled&&row.last_seen&&Number(row.last_seen)>Date.now()-PRESENCE_TTL_MS&&activeIds.has(row.presence_token+':'+row.uid);
    // Mojang's UUID adapter rejects explicit JSON null; external identities have no pmid.
    result.push({profileId:row.profile_id,status:active?row.presence_status:'OFFLINE',lastUpdated:new Date(Number(row.last_seen)||0).toISOString()});
  }
  return {presence:result};
}
