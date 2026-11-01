import { query, queryOne } from '../db.js';
import { findTextureByTid, textureExists, type Texture } from './texture.js';

/** Explicit avatar wins; otherwise follow the earliest role with an available skin. */
export async function resolveUserAvatar(uid: number): Promise<{ email: string; texture: Texture | null } | null> {
  if (!Number.isSafeInteger(uid) || uid < 1) return null;
  const user = await queryOne<{ avatar: number; email: string }>('SELECT avatar,email FROM users WHERE uid=?', [uid]);
  if (!user) return null;
  if (user.avatar > 0) {
    const texture = await findTextureByTid(user.avatar);
    if (texture && ['steve', 'alex'].includes(texture.type) && await textureExists(texture.hash)) return { email: user.email, texture };
  }
  const equipped = await query<Texture>(
    'SELECT t.* FROM players p JOIN textures t ON t.tid=p.tid_skin WHERE p.uid=? AND t.type IN (?,?) ORDER BY p.pid ASC',
    [uid, 'steve', 'alex'],
  );
  for (const texture of equipped) if (await textureExists(texture.hash)) return { email: user.email, texture };
  return { email: user.email, texture: null };
}
