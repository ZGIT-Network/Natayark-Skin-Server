import { getOption, setOption, loadOptions } from './option.js';
import {queryOne,withTransaction} from '../db.js';

export function configurePlugin(value: unknown, name: string, enabled: boolean): unknown {
  if(typeof value==='string')value=value?JSON.parse(value):[];
  if(!Array.isArray(value)&&(!value||typeof value!=='object'))throw new Error('Invalid plugin configuration');
  if(enabledPluginNames(value).includes(name)===enabled)return value;
  if(Array.isArray(value)) {
    const previous=value.find(item=>item===name||item?.name===name);
    const next=value.filter(item=>item!==name&&item?.name!==name);
    if(enabled)next.push(previous&&typeof previous==='object'?{...previous,enabled:true}:name);
    return next;
  }
  if(value&&typeof value==='object') {
    const next={...value} as Record<string,unknown>;
    if(enabled)next[name]=next[name]||true;else delete next[name];
    return next;
  }
  throw new Error('Invalid plugin configuration');
}
export async function setPluginEnabled(name:string,enabled:boolean):Promise<void> {
  try { await withTransaction(async()=>{
    await queryOne('SELECT uid FROM users ORDER BY uid LIMIT 1 FOR UPDATE');
    const row=await queryOne<{option_value:string}>('SELECT option_value FROM options WHERE option_name=? FOR UPDATE',['plugins_enabled']);
    const raw=row?.option_value??'[]',next=configurePlugin(raw,name,enabled);
    if(JSON.stringify(next)!==JSON.stringify(raw?JSON.parse(raw):[]))await setOption('plugins_enabled',JSON.stringify(next));
  }); } catch(error){await loadOptions(true);throw error;}
}

export function enabledPluginNames(value: unknown): string[] {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => typeof item === 'string' ? [item] : item && typeof item.name === 'string' && item.enabled !== false ? [item.name] : []))];
  if (value && typeof value === 'object') return Object.entries(value).filter(([,setting])=>setting !== false && setting !== null).map(([name])=>name);
  return [];
}
export async function pluginEnabled(name: string): Promise<boolean> {
  return enabledPluginNames(await getOption('plugins_enabled','[]')).includes(name);
}
