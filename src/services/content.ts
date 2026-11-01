import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { getOptionInt } from './option.js';
import { queryOne } from '../db.js';
import { config } from '../config.js';

export function renderMarkdown(value: string): string {
  return sanitizeHtml(marked.parse(value, { async: false }) as string);
}

export async function descriptionLimit(): Promise<number> {
  const configured=Math.max(0,await getOptionInt('textures_description_limit',0));
  const column=await queryOne<{type:string;capacity:number}>('SELECT DATA_TYPE AS type,CHARACTER_MAXIMUM_LENGTH AS capacity FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[config.db.tablePrefix+'textures_description','description']);
  const legacyCapacity=column&&['varchar','char'].includes(column.type)?Number(column.capacity):0;
  return configured&&legacyCapacity?Math.min(configured,legacyCapacity):configured||legacyCapacity;
}

export async function validateDescription(value: unknown): Promise<string> {
  if (value !== null && value !== undefined && typeof value !== 'string') throw Object.assign(new Error('描述必须为文字'), {statusCode:422});
  const text = String(value ?? '');
  const limit = await descriptionLimit();
  if (limit && [...text].length > limit) throw Object.assign(new Error(`描述不能超过 ${limit} 个字符`), {statusCode:422});
  if (Buffer.byteLength(text, 'utf8') > 65535) throw Object.assign(new Error('描述内容过长，请控制在 64KB 以内'), {statusCode:422});
  return text;
}
