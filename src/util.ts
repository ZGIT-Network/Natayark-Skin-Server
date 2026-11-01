import crypto from 'node:crypto';

export function uuid4Hex(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export function uuid4(): string {
  return crypto.randomUUID();
}

/** Minecraft offline-mode UUID v3: md5("OfflinePlayer:" + name), version/variant bits set. */
export function offlineUuidV3Hex(name: string): string {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

/** UUID v5 (SHA-1 based) with a DNS-like namespace string, matching Ramsey's Uuid::uuid5(NAMESPACE_DNS, ...). */
export function uuid5Hex(namespaceDnsName: string, value: string): string {
  // RFC 4122 namespace for DNS
  const ns = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(Buffer.from(value, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

export function randomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomToken(len = 40): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomInt(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

/** Player name rules, mirroring Blessing Skin's PlayerName rule. */
export function validatePlayerName(name: string): boolean {
  const rule = optionPlayerNameRule;
  let regexp: RegExp;
  switch (rule) {
    case 'official':
      regexp = /^[A-Za-z0-9_]+$/;
      break;
    case 'cjk':
      regexp = /^[A-Za-z0-9_§一-鿿]+$/u;
      break;
    case 'custom':
      regexp = optionCustomPlayerNameRegexp ? safeRegex(optionCustomPlayerNameRegexp) : /^[A-Za-z0-9_一-鿿]+$/u;
      break;
    case 'utf8':
    default:
      // Mirrors BS: valid UTF-8, no whitespace characters
      regexp = /^[^\s]+$/u;
      break;
  }
  if (!regexp.test(name)) return false;
  const min = optionPlayerNameLengthMin;
  const max = optionPlayerNameLengthMax;
  return [...name].length >= min && [...name].length <= max;
}

import { getOption } from './services/option.js';
let optionPlayerNameRule = 'utf8';
let optionCustomPlayerNameRegexp = '';
let optionPlayerNameLengthMin = 3;
let optionPlayerNameLengthMax = 16;
export async function loadPlayerNameRules(): Promise<void> {
  optionPlayerNameRule = await getOption('player_name_rule', 'utf8');
  optionCustomPlayerNameRegexp = await getOption('custom_player_name_regexp', '');
  optionPlayerNameLengthMin = parseInt(await getOption('player_name_length_min', '3'), 10) || 3;
  optionPlayerNameLengthMax = parseInt(await getOption('player_name_length_max', '16'), 10) || 16;
}

export function compileLegacyPattern(input:string):RegExp|null {
  let source=input,flags='u';
  if(input.length>2&&['/','#','~','!','%'].includes(input[0])){
    const end=input.lastIndexOf(input[0]);
    if(end<=0)return null;
    source=input.slice(1,end);const modifiers=input.slice(end+1);
    if(/[^imsuAD]/.test(modifiers))return null;
    flags=[...new Set(('u'+modifiers.replace(/[AD]/g,'')).split(''))].join('');
    if(modifiers.includes('A'))source='^(?:'+source+')';
    if(modifiers.includes('D')&&source.endsWith('$'))source=source.slice(0,-1)+'$(?![\\s\\S])';
  }
  try {
    return new RegExp(source,flags);
  }catch{return null;}
}
const safeRegex=(source:string)=>compileLegacyPattern(source)??/(?!)/;

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function parseBool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return v === '1' || v === 'true' || v === 1;
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
