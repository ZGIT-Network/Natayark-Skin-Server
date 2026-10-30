import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Player } from '../services/player.js';
import { setPlayerTexture } from '../services/player.js';
import { findUserByUid } from '../services/user.js';
import { uploadTexture, closetAdd, closetHas, type TextureMeta } from '../services/texture.js';
import { YggdrasilError, illegalArgument, forbiddenOperation } from './yggdrasil.js';
import { yggLog } from '../services/ygglog.js';
import { withTransaction } from '../db.js';
import { PNG } from 'pngjs';

/**
 * Shared texture-upload routine used by the Yggdrasil Bearer endpoint and the
 * web API. Accepts multipart/form-data (fields: model, file) or a raw PNG body
 * with ?model=slim.
 */
export async function uploadTextureDirect(request: FastifyRequest, reply: FastifyReply, player: Player, type: 'skin' | 'cape'): Promise<void> {
  const user = await findUserByUid(player.uid);
  if (!user) throw forbiddenOperation('The player owner does not exist');

  let data: Buffer | null = null;
  let modelName: string | null = null;
  let fileName = 'skin.png';

  const contentType = String(request.headers['content-type'] ?? '');
  if (contentType.includes('multipart/form-data')) {
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'model') {
        modelName = String(part.value ?? 'default');
      } else if (part.type === 'file' && part.fieldname === 'file') {
        data = await (part as any).toBuffer();
        fileName = part.filename || fileName;
      } else if (part.type === 'file') {
        // ignore other files
        await (part as any).toBuffer().catch(() => null);
      }
    }
  } else {
    data = (request.body as Buffer) ?? null;
    const query = request.query as Record<string, string | undefined>;
    modelName = query.model ?? 'default';
  }

  if (!data || data.length === 0) throw illegalArgument('Texture file is required');
  if (!['', 'default', 'slim', null].includes(modelName)) throw illegalArgument('Invalid texture model');
  if (type === 'cape' && data.length >= 24) {
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    // Yggdrasil's 22:17 cape layout is padded to the standard 64:32 canvas.
    if (width > 0 && width % 22 === 0 && height === width / 22 * 17 && width / 22 * 64 <= 4096) {
      let original: PNG;
      try { original = PNG.sync.read(data); } catch { throw illegalArgument('Invalid PNG image'); }
      const scale = width / 22;
      const padded = new PNG({ width: 64 * scale, height: 32 * scale });
      original.bitblt(padded, 0, 0, width, height, 0, 0);
      data = PNG.sync.write(padded);
    }
  }
  const isSlim = modelName === 'slim' && type === 'skin';

  const meta: TextureMeta = {
    name: fileName.replace(/\.png$/i, '').slice(0, 50) || 'skin',
    type: type === 'cape' ? 'cape' : isSlim ? 'alex' : 'steve',
    isPublic: false, // uploads via the Yggdrasil API stay private (as in the old plugin)
  };

  await withTransaction(async () => {
  const result = await uploadTexture({ uid: user.uid, score: user.score }, meta, { data, name: meta.name }, { source: 'yggdrasil' });
  if (!result.ok) {
    if (result.reason === 'lack_score') throw forbiddenOperation('Insufficient score to upload this texture');
    if (result.reason === 'file-too-large') throw illegalArgument('Texture file is too large');
    if (result.reason === 'invalid-cape-size') throw illegalArgument('Invalid cape size, the ratio must be 2:1');
    if (result.reason === 'invalid-slim-size') throw illegalArgument('Slim skins must have a 1:1 ratio');
    if (result.reason === 'invalid-hd-skin') throw illegalArgument('Invalid HD skin, width must be a multiple of 64 and height a multiple of 32');
    throw illegalArgument('Invalid skin, the ratio must be 1:1 or 2:1');
  }

  if (result.duplicate && !(await closetHas(user.uid, result.texture.tid))) {
    const added = await closetAdd(user.uid, result.texture.tid, result.texture.name);
    if (!added.ok && added.reason !== 'dup') throw forbiddenOperation('Insufficient score or permission to add texture to closet');
  }
  await setPlayerTexture(player, type, result.texture.tid);
  await yggLog({
    action: 'upload_texture',
    user_id: user.uid,
    player_id: player.pid,
    parameters: { type, tid: result.texture.tid },
    ip: request.ip,
  });
  });
  return reply.code(204).send();
}
