import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getOptionInt } from './option.js';
import { WorkLimit, boundedEnv } from './work-limit.js';

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export async function uploadByteLimit(): Promise<number> {
  return Math.max(1, Math.min(MAX_UPLOAD_BYTES, await getOptionInt('max_upload_file_size', 1024) * 1024));
}

export async function textureParts(request: FastifyRequest) {
  return request.parts({ limits: { fileSize: await uploadByteLimit(), files: 1, fields: 16, fieldSize: 65536, parts: 17 } });
}

/** Hold a slot from before the body is read until the response/abort completes. */
export function registerUploadLimits(app: FastifyInstance): void {
  const work = new WorkLimit(boundedEnv('UPLOAD_CONCURRENCY', 2, 16));
  const releases = new WeakMap<FastifyRequest, () => void>();
  app.addHook('onRequest', async (request, reply) => {
    if (!(request.method === 'POST' && request.url.split('?')[0] === '/api/skinlib') &&
        !(request.method === 'PUT' && /^\/api\/yggdrasil\/api\/user\/profile\//.test(request.url))) return;
    try {
      const release = await work.acquire();
      releases.set(request, release);
      request.raw.once('aborted', release);
    } catch { return reply.header('Retry-After', '1').code(503).send({ message: '上传繁忙，请稍后重试' }); }
    const length = Number(request.headers['content-length']);
    // Bound the request envelope as well as each streamed file.
    if (length > await uploadByteLimit() + 16 * 65536) return reply.code(413).send({ message: '文件过大' });
  });
  app.addHook('onResponse', async request => { releases.get(request)?.(); releases.delete(request); });
}
