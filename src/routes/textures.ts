import type { FastifyInstance } from 'fastify';
import { queryOne, localStringToEpoch } from '../db.js';
import { getOption, getOptionBool, getOptionInt, getOptionLocalized } from '../services/option.js';
import { findTextureByTid } from '../services/texture.js';
import { textureExists, texturePath } from '../services/texture.js';
import { render2dAvatar, render3dAvatar, renderSkin, renderCape, defaultAvatar, resizeTo, pngToBuffer, loadTextureData } from '../services/render.js';
import type { Texture } from '../services/texture.js';
import { attachTextures } from '../services/player.js';
import { pageContext } from './page-context.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import sharp from 'sharp';
import {resolveUserAvatar} from '../services/avatar.js';

async function cacheHeader(reply: any): Promise<void> {
  const seconds = await getOptionInt('cache_expire_time', 31536000);
  reply.header('Cache-Control', `public, max-age=${seconds}`);
}

const encodedPreviews = new Map<string, Buffer>();
async function sendPng(reply: any, source: Buffer, lastModified?: Date): Promise<void> {
  const png = Object.hasOwn(reply.request.query ?? {}, 'png');
  let buffer = source;
  if (!png) {
    const key = crypto.createHash('sha256').update(source).digest('hex');
    const cached = encodedPreviews.get(key);
    if (cached) buffer = cached;
    else {
      buffer = await sharp(source).webp({ lossless: true }).toBuffer();
      if (encodedPreviews.size >= 128) encodedPreviews.delete(encodedPreviews.keys().next().value!);
      encodedPreviews.set(key, buffer);
    }
  }
  const etag = `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;
  reply.header('Content-Type', png ? 'image/png' : 'image/webp');
  reply.header('Content-Length', buffer.length);
  reply.header('ETag', etag);
  if (lastModified) reply.header('Last-Modified', lastModified.toUTCString());
  const inm = String(reply.request.headers['if-none-match'] || '');
  if (inm.split(',').map((v: string) => v.trim().replace(/^W\//, '')).includes(etag)) return reply.code(304).send();
  return reply.send(buffer);
}

// In-memory render cache mirroring the legacy Cache::remember behaviour.
type CacheEntry = { buffer: Buffer; mtime: Date; expires: number };
const renderCache = new Map<string, CacheEntry>();
function cacheGet(key: string): CacheEntry | null {
  const entry = renderCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) { renderCache.delete(key); return null; }
  return entry;
}
function cacheSet(key: string, buffer: Buffer, mtime: Date, ttlSeconds: number): void {
  if (renderCache.size > 512) {
    const oldest = renderCache.keys().next().value;
    if (oldest) renderCache.delete(oldest);
  }
  renderCache.set(key, { buffer, mtime, expires: Date.now() + ttlSeconds * 1000 });
}

export async function registerTextureRoutes(app: FastifyInstance): Promise<void> {
  app.get('/preview/default', async (_request, reply) => {
    const data = await fs.promises.readFile(path.join(ROOT_DIR, 'public/app/default-skin.png'));
    return sendPng(reply, pngToBuffer(renderSkin(data, 12, false)));
  });
  // Raw texture files (same as BS: publicly served by hash)
  const rawHash = async (hash: string, request: any, reply: any) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return reply.code(404).send();
    try {
      // Open before sending so ENOENT maps to 404, not an async stream 500.
      const handle = await fs.promises.open(texturePath(hash), 'r');
      const stat = await handle.stat();
      reply.header('Content-Type', 'image/png').header('X-Content-Type-Options', 'nosniff');
      reply.header('ETag', `"${hash}"`).header('Last-Modified', stat.mtime.toUTCString());
      await cacheHeader(reply);
      if (request.headers['if-none-match']?.split(',').map((v: string) => v.trim()).includes(`"${hash}"`)) {
        await handle.close();
        return reply.code(304).send();
      }
      reply.header('Content-Length', stat.size);
      return reply.send(handle.createReadStream());
    } catch (error: any) {
      if (error.code === 'ENOENT') return reply.code(404).send();
      throw error;
    }
  };
  for (const prefix of ['/textures', '/csl/textures', '/usm/textures']) app.get(`${prefix}/:hash`, async (request, reply) => {
    return rawHash((request.params as { hash: string }).hash, request, reply);
  });

  // Raw download by tid (gated, as in BS)
  app.get('/raw/:tid', async (request, reply) => {
    if (!(await getOptionBool('allow_downloading_texture', false))) {
      return reply.code(403).send();
    }
    const { tid } = request.params as { tid: string };
    const texture = await findTextureByTid(parseInt(tid, 10));
    if (!texture || !(await textureExists(texture.hash))) return reply.code(404).send();
    return rawHash(texture.hash, request, reply);
  });

  // Avatars (legacy /avatar/*: head-only, 2d flat or ?3d isometric) ----------
  const avatarFromTexture = async (texture: Texture | null, request: any, reply: any,mutable=false) => {
    const query = request.query as Record<string, string>;
    const size = clampSize(query?.size, 1024);
    const mode = query?.['3d'] !== undefined ? '3d' : '2d';
    if (texture && texture.type !== 'steve' && texture.type !== 'alex') return reply.code(422).send();
    if(mutable)reply.header('Cache-Control','public, max-age=0, must-revalidate');else await cacheHeader(reply);
    if (!texture) {
      return sendPng(reply, pngToBuffer(defaultAvatar(size, mode)));
    }
    const key = `avatar:${mode}:${texture.tid}:${size}`;
    const cached = cacheGet(key);
    if (cached) return sendPng(reply, cached.buffer, cached.mtime);
    const data = texture.type && (await textureExists(texture.hash)) ? await loadTextureData(texture.hash) : null;
    if (!data) return sendPng(reply, pngToBuffer(defaultAvatar(size, mode)));
    const rendered = resizeTo(mode === '3d' ? render3dAvatar(data) : render2dAvatar(data), size);
    const buffer = pngToBuffer(rendered);
    let mtime = new Date();
    try { mtime = (await fs.promises.stat(texturePath(texture.hash))).mtime; } catch { /* fresh timestamp */ }
    const ttl = (await getOptionBool('enable_avatar_cache', false)) ? 31536000 : 60;
    cacheSet(key, buffer, mtime, ttl);
    return sendPng(reply, buffer, mtime);
  };

  app.get('/avatar/player/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const player = await queryOne<any>('SELECT tid_skin FROM players WHERE name = ? LIMIT 1', [name]);
    if (!player) return reply.code(404).send();
    const texture = player && player.tid_skin > 0 ? await findTextureByTid(player.tid_skin) : null;
    return avatarFromTexture(texture, request, reply);
  });

  app.get('/avatar/user/:uid', async (request, reply) => {
    const { uid } = request.params as { uid: string };
    const avatar=await resolveUserAvatar(parseInt(uid,10));
    reply.header('Cache-Control','public, max-age=0, must-revalidate');
    if(!avatar)return avatarFromTexture(null,request,reply,true);
    if (!avatar.texture && await pluginEnabled('gravatar')) {
      const hash = crypto.createHash('md5').update(avatar.email.trim().toLowerCase()).digest('hex');
      return reply.redirect(`https://weavatar.com/avatar/${hash}?s=${clampSize((request.query as any)?.size)}`);
    }
    return avatarFromTexture(avatar.texture, request, reply,true);
  });

  app.get('/avatar/hash/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const row = await queryOne<any>('SELECT tid, type, hash FROM textures WHERE hash = ? LIMIT 1', [hash]);
    return avatarFromTexture(row ?? null, request, reply);
  });

  app.get('/avatar/:tid', async (request, reply) => {
    const { tid } = request.params as { tid: string };
    const texture = await findTextureByTid(parseInt(tid, 10));
    return avatarFromTexture(texture, request, reply);
  });

  // Previews (legacy /preview/*: two isometric body views; capes scale to ?height) ---
  const previewFromTexture = async (texture: Texture | null, request: any, reply: any) => {
    if (!texture) return reply.code(404).send();
    await cacheHeader(reply);
    const height = clampSize(request.query?.height ?? 200, 2000);
    const key = `preview:${texture.tid}:${texture.hash}:${texture.type}:${texture.type === 'cape' ? height : 'body'}`;
    const cached = cacheGet(key);
    if (cached) return sendPng(reply, cached.buffer, cached.mtime);
    const data = await loadTextureData(texture.hash);
    if (!data) return reply.code(404).send();
    const rendered = texture.type === 'cape' ? renderCape(data, height) : renderSkin(data, 12, texture.type === 'alex');
    const buffer = pngToBuffer(rendered);
    let mtime = new Date();
    try { mtime = (await fs.promises.stat(texturePath(texture.hash))).mtime; } catch { /* fresh timestamp */ }
    const ttl = (await getOptionBool('enable_preview_cache', false)) ? 31536000 : 60;
    cacheSet(key, buffer, mtime, ttl);
    return sendPng(reply, buffer, mtime);
  };

  app.get('/preview/:tid', async (request, reply) => {
    const { tid } = request.params as { tid: string };
    const texture = await findTextureByTid(parseInt(tid, 10));
    return previewFromTexture(texture, request, reply);
  });

  app.get('/preview/hash/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const row = await queryOne<any>('SELECT * FROM textures WHERE hash = ? LIMIT 1', [hash]);
    return previewFromTexture(row ?? null, request, reply);
  });

  // CustomSkinAPI R1: /{player}.json and /csl/{player}.json --------------------
  const cslHandler = async (request: any, reply: any) => {
    const playerParam = String(request.params.player ?? '');
    if (!playerParam.endsWith('.json')) return reply.code(404).send();
    const name = playerParam.slice(0, -5);
    const player = await queryOne<any>('SELECT * FROM players WHERE name = ? LIMIT 1', [name]);
    if (!player) return reply.code(await pluginEnabled('204-for-unexisted-players') ? 204 : 404).send();
    const banned = await queryOne('SELECT 1 FROM users WHERE uid = ? AND permission = -1', [player.uid]);
    if (banned) return reply.code(403).send();

    const [withTextures] = await attachTextures([player]);
    reply.header('Content-Type', 'application/json');
    await cacheHeader(reply);
    reply.header('Last-Modified', new Date(localStringToEpoch(player.last_modified)).toUTCString());
    return { username: player.name, skins: { [withTextures.model ?? 'default']: withTextures.skin?.hash ?? null }, cape: withTextures.cape?.hash ?? null };
  };
  // matched last; Fastify matches literal routes first, so /:player.json is safe here
  app.get('/:player', cslHandler);
  app.get('/csl/:player', cslHandler);

  app.get('/usm/:player', async (request, reply) => {
    const part = String((request.params as any).player);
    if (!part.endsWith('.json')) return reply.code(404).send();
    const player = await queryOne<any>('SELECT p.*, u.permission FROM players p JOIN users u ON u.uid = p.uid WHERE p.name = ? LIMIT 1', [part.slice(0, -5)]);
    if (!player) return reply.code(404).send({ errno: 1, msg: 'Player not found.' });
    if (player.permission < 0) return reply.code(403).send();
    const [profile] = await attachTextures([player]);
    const model = profile.model ?? 'default';
    await cacheHeader(reply);
    return { player_name: player.name, last_update: Math.floor(localStringToEpoch(player.last_modified) / 1000), model_preference: [model], skins: { [model]: profile.skin?.hash ?? null }, cape: profile.cape?.hash ?? null };
  });

  for (const type of ['skin', 'cape'] as const) app.get(`/${type}/:player`, async (request, reply) => {
    const part = String((request.params as any).player);
    if (!part.endsWith('.png')) return reply.code(404).send();
    const player = await queryOne<any>('SELECT p.*, u.permission FROM players p JOIN users u ON u.uid = p.uid WHERE p.name = ? LIMIT 1', [part.slice(0, -4)]);
    if (!player) return reply.code(404).send();
    if (player.permission < 0) return reply.code(403).send();
    const texture = await findTextureByTid(type === 'skin' ? player.tid_skin : player.tid_cape);
    if (!texture) return reply.code(404).send();
    return rawHash(texture.hash, request, reply);
  });

  app.get('/user/config', async (request, reply) => {
    if (!request.currentUser) return reply.redirect('/auth/login?redirect=/user/config');
    const siteName = await getOptionLocalized('site_name', request.currentUser.locale ?? 'zh_CN');
    const origin = (await getOption('site_url', '')).replace(/\/+$/, '');
    const self = { name: siteName, type: 'CustomSkinAPI', root: `${origin}/csl/` };
    const mojang = { name: 'Mojang', type: 'MojangAPI' };
    const csl = { enable: true, loadlist: await getOption('csl_first', 'self') === 'self' ? [self, mojang] : [mojang, self] };
    const usm = { rootURIs: [`${origin}/usm/`], legacySkinURIs: [], legacyCapeURIs: [] };
    const download = (request.query as any)?.download;
    if (['csl', 'extra', 'usm'].includes(download)) {
      const filename = download === 'csl' ? 'CustomSkinLoader.json' : download === 'usm' ? 'UniSkinMod.json' : 'MCNSKIN.json';
      return reply.header('Content-Disposition', `attachment; filename="${filename}"`).type('application/json; charset=utf-8').send(JSON.stringify(download === 'csl' ? csl : download === 'usm' ? usm : self, null, 2));
    }
    return reply.view('user/config', {
      ...(await pageContext(request, '客户端配置')),
      csl, usm, origin,
    });
  });
}

import { pluginEnabled } from '../services/plugins.js';

function clampSize(value: unknown, max = 512): number {
  const n = parseInt(String(value ?? '100'), 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(100, max);
  return Math.min(max, n);
}
