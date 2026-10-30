import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { hashSync as argonHashSync, verifySync as argonVerifySync, Algorithm } from '@node-rs/argon2';

const supported = new Set(['BCRYPT', 'PHP_PASSWORD_HASH', 'ARGON2I', 'MD5', 'SHA256', 'SHA512', 'SALTED2MD5', 'SALTED2SHA256', 'SALTED2SHA512']);
export const passwordMethod = (): string => (process.env.PWD_METHOD || 'BCRYPT').toUpperCase();
const digest = (algorithm: string, value: string): string => crypto.createHash(algorithm).update(value, 'utf8').digest('hex');
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Mirrors oldbf/app/Services/Cipher. Keep PWD_METHOD and SALT when sharing the PHP database. */
export async function hashPassword(plain: string): Promise<string> {
  const method = passwordMethod();
  if (!supported.has(method)) throw new Error('Unsupported PWD_METHOD');
  if (method === 'ARGON2I') return argonHashSync(plain, { algorithm: Algorithm.Argon2i });
  if (method === 'BCRYPT' || method === 'PHP_PASSWORD_HASH') return bcrypt.hashSync(plain, 10).replace(/^\$2[ab]\$/, '$2y$');
  const algorithm = method.replace('SALTED2', '').toLowerCase();
  const first = digest(algorithm, plain);
  return method.startsWith('SALTED2') ? digest(algorithm, first + (process.env.SALT || '')) : first;
}
export function verifyPassword(plain: string, hash: string): boolean {
  if (!hash || typeof plain !== 'string') return false;
  try {
    if (/^\$2[aby]\$/.test(hash)) return bcrypt.compareSync(plain, hash);
    if (/^\$argon2(?:i|id|d)\$/.test(hash)) return argonVerifySync(hash, plain);
    const method = passwordMethod();
    if (!supported.has(method) || ['BCRYPT', 'PHP_PASSWORD_HASH', 'ARGON2I'].includes(method)) return false;
    const algorithm = method.replace('SALTED2', '').toLowerCase();
    const first = digest(algorithm, plain);
    return safeEqual(hash, method.startsWith('SALTED2') ? digest(algorithm, first + (process.env.SALT || '')) : first);
  } catch { return false; }
}
/** Rehash only when preserving the configured algorithm so the PHP site can still read new hashes. */
export function needsRehash(hash: string): boolean {
  const method = passwordMethod();
  if (method === 'BCRYPT' || method === 'PHP_PASSWORD_HASH') {
    const match = /^\$2[aby]\$(\d\d)\$/.exec(hash);
    return !!match && Number(match[1]) < 10;
  }
  return false;
}
