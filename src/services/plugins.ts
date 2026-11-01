import { getOption } from './option.js';

export function enabledPluginNames(value: unknown): string[] {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => typeof item === 'string' ? [item] : item && typeof item.name === 'string' && item.enabled !== false ? [item.name] : []))];
  if (value && typeof value === 'object') return Object.entries(value).filter(([,setting])=>setting !== false && setting !== null).map(([name])=>name);
  return [];
}
export async function pluginEnabled(name: string): Promise<boolean> {
  return enabledPluginNames(await getOption('plugins_enabled','[]')).includes(name);
}
