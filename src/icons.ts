import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

const ICON_DIR = path.join(ROOT_DIR, 'node_modules', '@sicons', 'ionicons5');
const cache = new Map<string, string>();
const names: Record<string, string> = {
  'alert-triangle': 'WarningOutline', archive: 'AlbumsOutline', 'arrow-left': 'ArrowBackOutline',
  'arrow-right': 'ArrowForwardOutline', 'badge-check': 'ShieldCheckmarkOutline', blocks: 'CubeOutline',
  calendar: 'CalendarOutline', check: 'CheckmarkOutline', 'chevron-down': 'ChevronDownOutline',
  'chevron-left': 'ChevronBackOutline', 'chevron-right': 'ChevronForwardOutline', 'circle-check': 'CheckmarkCircleOutline',
  cloud: 'CloudOutline', 'code-xml': 'CodeSlashOutline', copy: 'CopyOutline', download: 'DownloadOutline',
  eye: 'EyeOutline', flag: 'FlagOutline', 'gamepad-2': 'GameControllerOutline', gift: 'GiftOutline',
  globe: 'GlobeOutline', heart: 'HeartOutline', home: 'HomeOutline', image: 'ImageOutline',
  info: 'InformationCircleOutline', 'key-round': 'KeyOutline', languages: 'LanguageOutline',
  'layout-dashboard': 'GridOutline', link: 'LinkOutline', 'log-in': 'LogInOutline', 'log-out': 'LogOutOutline',
  mail: 'MailOutline', menu: 'MenuOutline', moon: 'MoonOutline', paintbrush: 'BrushOutline',
  pencil: 'PencilOutline', plus: 'AddOutline', 'refresh-cw': 'RefreshOutline', 'rotate-ccw': 'ArrowUndoOutline',
  'scroll-text': 'ReaderOutline', search: 'SearchOutline', server: 'ServerOutline', settings: 'SettingsOutline',
  'share-2': 'ShareSocialOutline', 'shield-check': 'ShieldCheckmarkOutline', shirt: 'ShirtOutline',
  star: 'StarOutline', sun: 'SunnyOutline', 'trash-2': 'TrashOutline', unlink: 'UnlinkOutline',
  upload: 'CloudUploadOutline', 'user-plus': 'PersonAddOutline', 'user-round': 'PersonOutline',
  users: 'PeopleOutline', wallet: 'WalletOutline', wrench: 'ConstructOutline', x: 'CloseOutline',
  monitor: 'DesktopOutline', pause: 'PauseOutline', play: 'PlayOutline', stop: 'StopOutline',
  run: 'WalkOutline', layers: 'LayersOutline', camera: 'CameraOutline', expand: 'ExpandOutline',move:'MoveOutline',
};

/**
 * Render xicons' Ionicons outline SVGs without a client framework.
 * Semantic aliases keep templates independent of the underlying icon set.
 */
export function icon(name: string, className = 'size-4', extraAttrs = ''): string {
  if (!Object.hasOwn(names, name)) return '';
  let body = cache.get(name);
  if (body === undefined) {
    try {
      body = fs
        .readFileSync(path.join(ICON_DIR, `${names[name]}.svg`), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    } catch {
      body = '';
    }
    cache.set(name, body);
  }
  if (!body) return '';
  return body.replace(
    /<svg\b([^>]*)>/,
    `<svg$1 width="1em" height="1em" fill="currentColor" class="xicon ${className}" aria-hidden="true" focusable="false"${extraAttrs ? ' ' + extraAttrs : ''}>`
  );
}
