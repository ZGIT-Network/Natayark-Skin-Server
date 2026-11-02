import type { FastifyRequest } from 'fastify';
import sanitizeHtml from 'sanitize-html';
import { getOption, getOptionBool, getOptionLocalized } from '../services/option.js';
import { csrfToken } from '../services/session.js';
import { isAdmin } from '../services/user.js';
import { themeContext } from '../services/theme.js';
import { pluginEnabled } from '../services/plugins.js';
import { requestLocale,localeReturnTo } from '../services/locale.js';

/**
 * Shared template context for every server-rendered page so partials can rely
 * on the same variables regardless of which route group rendered the view.
 */
export async function pageContext(request: FastifyRequest, title: string): Promise<Record<string, any>> {
  const user = (request as any).currentUser;
  const darkMode = user?.is_dark_mode === 1;
  const locale = requestLocale(request);
  const pathname = String((request as any).url ?? '/').split('?')[0];
  return {
    ...(await themeContext()),
    title,
    user: user ? {
      uid: user.uid,
      email: user.email,
      nickname: user.nickname,
      score: user.score,
      permission: user.permission,
      avatar: user.avatar,
      locale: user.locale,
      verified: !!user.verified,
      isDarkMode: darkMode,
    } : null,
    hasPassword: !!user?.password,
    hideAdvancedMenu: await pluginEnabled('hide-advanced-menu'),
    hitokotoEnabled: await pluginEnabled('hitokoto'),
    isAdmin: isAdmin(user),
    siteName: await getOptionLocalized('site_name', locale),
    siteUrl: await getOption('site_url', ''),
    siteDescription: await getOptionLocalized('site_description', locale),
    copyrightText: sanitizeHtml(await getOption('copyright_text', '')),
    oauthProviders: [],
    localLoginEnabled: await getOptionBool('local_login_enabled', true),
    announcementHtml: '',
    csrf: csrfToken((request as any).session),
    currentPath: pathname,
    darkMode,
    locale,
    localeReturnTo:localeReturnTo(request.url),
    htmlLang: locale === 'en' ? 'en' : 'zh-CN',
    customCss: await getOption('custom_css', ''),
    customJs: await getOption('custom_js', ''),
    faviconUrl: await getOption('favicon_url', '/favicon.ico'),
    recaptchaSiteKey: await getOption('recaptcha_sitekey',''),
    recaptchaInvisible:await getOptionBool('recaptcha_invisible',false),
    t: (key: string, values?: Record<string, string | number>) => (request as any).t(key, values),
  };
}
