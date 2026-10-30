import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

function envStr(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}
function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const config = {
  port: envInt('PORT', 3000),
  host: envStr('HOST', '0.0.0.0'),
  appKey: envStr('APP_KEY', 'dev-insecure-key'),
  trustProxy: envBool('TRUST_PROXY', false),
  publicOrigin: envStr('PUBLIC_ORIGIN').replace(/\/$/, ''),
  oidcIssuer: envStr('OIDC_ISSUER').replace(/\/$/, ''),
  legacyDir: envStr('LEGACY_DIR'),

  db: {
    host: envStr('DB_HOST', '127.0.0.1'),
    port: envInt('DB_PORT', 3306),
    database: envStr('DB_DATABASE', 'mcnskin'),
    user: envStr('DB_USERNAME', 'mcnskin'),
    password: envStr('DB_PASSWORD', ''),
    tablePrefix: envStr('DB_TABLE_PREFIX'),
  },

  textureDir: path.resolve(ROOT_DIR, envStr('TEXTURE_DIR', 'storage/textures')),
  storageDir: path.resolve(ROOT_DIR, envStr('STORAGE_DIR', 'storage')),

  mail: {
    host: envStr('MAIL_HOST'),
    port: envInt('MAIL_PORT', 465),
    secure: envBool('MAIL_SECURE', true),
    username: envStr('MAIL_USERNAME'),
    password: envStr('MAIL_PASSWORD'),
    fromAddress: envStr('MAIL_FROM_ADDRESS'),
    fromName: envStr('MAIL_FROM_NAME', 'Natayark SkinServer'),
  },

  yggRateLimit: envInt('YGG_RATE_LIMIT', 60),

  // Timezone used for writing datetime strings to the DB (matches PHP behaviour).
  tz: envStr('TZ', 'Asia/Shanghai'),
};

export const isDev = process.env.NODE_ENV !== 'production';
if (!isDev && (config.appKey === 'dev-insecure-key' || config.appKey.length < 32)) {
  throw new Error('APP_KEY must be a private random value of at least 32 characters in production');
}
