import crypto from 'node:crypto';
import { exec, nowString, query, queryOne, withTransaction } from '../db.js';
import { renderMarkdown } from './content.js';

export function pageNumber(value: unknown, fallback = 1, maximum = 1000000): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

export async function siteChart() {
  const start = nowString(-30 * 86400).slice(0, 10);
  const xAxis = Array.from({length:31}, (_, index) => new Date(Date.parse(start + 'T00:00:00Z') + index * 86400000).toISOString().slice(0,10));
  const [users, textures] = await Promise.all([
    query<{day:string;count:number}>('SELECT DATE(register_at) AS day, COUNT(*) AS count FROM users WHERE register_at >= ? GROUP BY DATE(register_at)',[start]),
    query<{day:string;count:number}>('SELECT DATE(upload_at) AS day, COUNT(*) AS count FROM textures WHERE upload_at >= ? GROUP BY DATE(upload_at)',[start]),
  ]);
  return {labels:['新增用户','上传材质'],xAxis,data:[users,textures].map(rows => {const values = new Map(rows.map(row => [row.day,Number(row.count)])); return xAxis.map(day => values.get(day) ?? 0);})};
}

export async function siteSummary() {
  return (await queryOne<{users:number;players:number;textures:number;storage:number;pending:number}>(
    'SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM players) AS players, (SELECT COUNT(*) FROM textures) AS textures, (SELECT COALESCE(SUM(size),0) FROM textures) AS storage, (SELECT COUNT(*) FROM reports WHERE status=0) AS pending'
  ))!;
}

type NotificationRow = {id:string;data:string;read_at:string|null;created_at:string};
export function notificationView(row: NotificationRow) {
  let data: any = {};
  try { data = JSON.parse(row.data); } catch { /* Legacy invalid JSON is still a readable notification. */ }
  const title = typeof data?.title === 'string' ? data.title : '站内通知';
  const content = typeof data?.content === 'string' ? data.content : typeof data?.message === 'string' ? data.message : '';
  return {...row,title,content,html:renderMarkdown(content)};
}

export async function notificationInbox(uid: number, page = 1, unreadOnly = false) {
  const where = 'WHERE notifiable_id=? AND notifiable_type IN (?,?)' + (unreadOnly ? ' AND read_at IS NULL' : '');
  const params = [uid,'App\\Models\\User','App\\User'];
  const count = await queryOne<{total:number}>(`SELECT COUNT(*) AS total FROM notifications ${where}`,params);
  const rows = await query<NotificationRow>(`SELECT id,data,read_at,created_at FROM notifications ${where} ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?`,[...params,(page - 1) * 20]);
  return {rows:rows.map(notificationView),total:Number(count?.total ?? 0),page,pages:Math.max(1,Math.ceil(Number(count?.total ?? 0) / 20))};
}

export async function readNotification(uid: number, id: string) {
  const row = await queryOne<NotificationRow>('SELECT id,data,read_at,created_at FROM notifications WHERE id=? AND notifiable_id=? AND notifiable_type IN (?,?)',[id,uid,'App\\Models\\User','App\\User']);
  if (!row) return null;
  if (!row.read_at) await exec('UPDATE notifications SET read_at=?,updated_at=? WHERE id=? AND notifiable_id=? AND read_at IS NULL',[nowString(),nowString(),id,uid]);
  const item = notificationView(row);
  return {title:item.title,content:item.html,time:item.created_at};
}

export async function sendSiteNotification(body: Record<string,unknown>): Promise<number> {
  if (body.receiver !== undefined && !['all','normal','uid','email'].includes(String(body.receiver))) throw new Error('无效的接收对象');
  if ((body.content !== undefined && typeof body.content !== 'string') || (body.message !== undefined && typeof body.message !== 'string')) throw new Error('通知正文必须为文字');
  const title = String(body.title ?? '').trim(), content = String(body.content ?? body.message ?? '');
  if (!title || [...title].length > 100 || content.length > 10000) throw new Error('请填写 1–100 字的标题，正文不超过 10000 字');
  let users: Array<{uid:number}>;
  if (body.receiver === 'all' || body.receiver === 'normal') {
    users = await query<{uid:number}>('SELECT uid FROM users' + (body.receiver === 'normal' ? ' WHERE permission=0' : ''));
  } else if (body.receiver === 'email') {
    users = await query<{uid:number}>('SELECT uid FROM users WHERE email=?',[String(body.email ?? '').trim()]);
  } else {
    const ids = [...new Set((Array.isArray(body.users) ? body.users : [body.uid]).map(Number))];
    if (!ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('请选择有效的用户 UID');
    users = await query<{uid:number}>(`SELECT uid FROM users WHERE uid IN (${ids.map(() => '?').join(',')})`,ids);
    if (users.length !== ids.length) throw new Error('部分接收用户不存在');
  }
  if (!users.length) throw new Error('没有符合条件的接收用户');
  const now = nowString();
  await withTransaction(async () => {
    for (let offset = 0; offset < users.length; offset += 200) {
      const batch = users.slice(offset,offset + 200);
      await exec(`INSERT INTO notifications (id,type,notifiable_type,notifiable_id,data,created_at,updated_at) VALUES ${batch.map(() => '(?,?,?,?,?,?,?)').join(',')}`,
        batch.flatMap(user => [crypto.randomUUID(),'App\\Notifications\\SiteMessage','App\\Models\\User',user.uid,JSON.stringify({title,content}),now,now]));
    }
  });
  return users.length;
}
