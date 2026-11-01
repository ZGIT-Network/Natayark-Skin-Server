import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLocale, type Locale } from '../i18n.js';
import { exec } from '../db.js';

export const LOCALE_COOKIE = 'mcnskin_locale';

/** An explicit saved preference wins over historical language query parameters. */
export function requestLocale(request: FastifyRequest): Locale {
  const account = request.currentUser?.locale;
  const browser = request.cookies?.[LOCALE_COOKIE];
  const preview = (request.query as { lang?: string } | undefined)?.lang;
  return isLocale(account) ? account : isLocale(browser) ? browser : isLocale(preview) ? preview : 'zh_CN';
}

export function localeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://locale.invalid');
    if (url.origin !== 'https://locale.invalid') return '/';
    url.searchParams.delete('lang');
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

export async function saveLocale(request: FastifyRequest, reply: FastifyReply, locale: Locale): Promise<void> {
  if (request.currentUser) {
    await exec('UPDATE users SET locale=? WHERE uid=?', [locale, request.currentUser.uid]);
    request.currentUser.locale = locale;
  }
  reply.setCookie(LOCALE_COOKIE, locale, {
    path: '/', httpOnly: true, sameSite: 'lax', maxAge: 31536000,
    secure: process.env.NODE_ENV === 'production',
  });
}
