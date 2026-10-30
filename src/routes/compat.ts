import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { query, queryOne, exec, nowString, withTransaction, insert } from '../db.js';
import { getOption, getOptionInt, getOptionBool } from '../services/option.js';
import { isAdmin } from '../services/user.js';
import { pageContext as sharedPageContext } from './page-context.js';
import { listPlayersOfUser, bindSinglePlayer, findPlayerByPid, clearPlayerTexture } from '../services/player.js';
import { closetOf, closetAdd, closetRemove, findTextureByTid, skinlibSearch, textureNameValid, getDescription, setDescription } from '../services/texture.js';

export function captureApiHandlers(app: FastifyInstance): Map<string, any> {
  const routes = new Map<string, any>();
  app.addHook('onRoute', route => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.set(`${method} ${route.url}`, route.handler);
  });
  return routes;
}

export async function registerCompatRoutes(app: FastifyInstance, handlers: Map<string, any>): Promise<void> {
  const fail = (reply: any, status: number, message: string) => reply.code(status).send({code:1,message});
  const alias = (method: any, url: string, target: string, adapt?: (request: any) => void) => {
    const handler = handlers.get(`${method} ${target}`) ?? (target.endsWith('/review') ? handlers.get(`POST ${target}`) : null);
    if (!handler) throw new Error(`Missing compatibility target ${method} ${target}`);
    app.route({method,url,config:{legacyWrite:!['GET','HEAD'].includes(method)} as any,handler:async (request, reply) => {
      adapt?.(request);
      return handler.call(app,request,reply);
    }});
  };
  for (const [key] of [...handlers]) {
    const [method, url] = key.split(' ');
    if (method === 'HEAD') continue;
    if (url.startsWith('/api/player')) {
      alias(method,url.replace('/api/player','/api/players'),url);
      alias(method,url.replace('/api/player','/user/player'),url);
    }
    if (url.startsWith('/api/closet')) alias(method,url.replace('/api/closet','/user/closet'),url);
    if (url.startsWith('/api/skinlib') && !url.endsWith('/report')) alias(method,url.replace('/api/skinlib','/texture'),url);
  }
  for (const prefix of ['/admin','/api/admin']) {
    for (const field of ['email','verification','nickname','password','score','permission']) alias('PUT',`${prefix}/users/:uid/${field}`,'/api/admin/user/:uid',r=>{
      const body=r.body??{};r.body={...body,field:field==='verification'?'verified':field,value:body.value??body[field]??(field==='verification'?body.verified:'')};
    });
    alias('DELETE',`${prefix}/users/:uid`,'/api/admin/user/:uid');
    for (const field of ['name','owner']) alias('PUT',`${prefix}/players/:pid/${field}`,'/api/admin/player/:pid',r=>{const body=r.body??{};r.body={...body,field,value:body.value??body[field]};});
    alias('DELETE',`${prefix}/players/:pid`,'/api/admin/player/:pid');
    alias('PUT',`${prefix}/reports/:id`,'/api/admin/report/:id/review');
  }
  alias('POST','/skinlib/report','/api/skinlib/:tid/report',r=>{r.params={tid:String(r.body?.tid??0)};});

  app.get('/api',async()=>({name:await getOption('site_name','MCNSKIN'),api:'Blessing Skin',yggdrasil:'/api/yggdrasil'}));
  app.get('/api/user',async request=>{
    const user=request.currentUser!;const {password,verification_token,remember_token,...safe}=user;return safe;
  });
  const players=async(request:any,reply:any)=>request.currentUser?listPlayersOfUser(request.currentUser.uid):fail(reply,401,'请先登录');
  app.get('/api/players',players); app.get('/user/player/list',players);
  const closet=async(request:any,reply:any)=>{
    if(!request.currentUser)return fail(reply,401,'请先登录');
    const items=await closetOf(request.currentUser.uid), q=request.query??{};
    return items.filter(i=>(!q.type||i.type===q.type||q.type==='skin'&&i.type!=='cape')&&(!q.q||i.item_name.toLowerCase().includes(String(q.q).toLowerCase())));
  };
  app.get('/api/closet',closet); app.get('/user/closet/list',closet);
  app.get('/user/closet/ids',async(request,reply)=>request.currentUser?(await closetOf(request.currentUser.uid)).map(i=>i.tid):fail(reply,401,'请先登录'));
  for(const path of ['/api/players/:pid/textures','/user/player/:pid/textures'])app.delete(path,{config:{legacyWrite:true} as any},async(request,reply)=>{
    if(!request.checkCsrf((request.body as any)?.csrf))return fail(reply,403,'CSRF 校验失败');
    const player=await findPlayerByPid(Number((request.params as any).pid));
    if(!player)return fail(reply,404,'角色不存在');
    if(player.uid!==request.currentUser!.uid&&!isAdmin(request.currentUser))return fail(reply,403,'无权操作');
    const body=request.body as any??{};
    if(body.skin!==false&&body.skin!=='false')await clearPlayerTexture(player,'skin');
    if(body.cape!==false&&body.cape!=='false')await clearPlayerTexture(player,'cape');
    return {code:0,message:'材质已清除'};
  });

  const textureInfo=async(request:any,reply:any)=>{
    const item=await findTextureByTid(Number(request.params.tid));
    if(!item)return fail(reply,404,'材质不存在');
    if(!item.public&&item.uploader!==request.currentUser?.uid&&!isAdmin(request.currentUser))return fail(reply,403,'无权访问私有材质');
    return {...item,description:await getDescription(item.tid)};
  };
  app.get('/texture/:tid',textureInfo); app.get('/skinlib/info/:tid',textureInfo);
  app.get('/skinlib/list',async request=>{
    const q=request.query as any;return skinlibSearch({keyword:String(q.q??q.keyword??'').slice(0,100),type:q.type,status:q.status,sort:q.sort,page:Math.max(1,Number(q.page)||1),perPage:Math.min(100,Math.max(1,Number(q.per_page)||18)),viewer:request.currentUser?{uid:request.currentUser.uid,admin:isAdmin(request.currentUser)}:null});
  });
  for(const field of ['name','type'])app.put(`/texture/:tid/${field}`,{config:{legacyWrite:true} as any},async(request,reply)=>{
    const body=request.body as any??{};
    if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    const texture=await findTextureByTid(Number((request.params as any).tid));
    if(!texture)return fail(reply,404,'材质不存在');
    if(texture.uploader!==request.currentUser!.uid&&!isAdmin(request.currentUser))return fail(reply,403,'无权修改');
    if(field==='name'){
      const name=String(body.name??'').trim();if(!name||name.length>50||!await textureNameValid(name))return fail(reply,400,'名称不符合规则');
      await exec('UPDATE textures SET name = ? WHERE tid = ?',[name,texture.tid]);
    }else if(field==='type'){
      if(texture.type==='cape'||!['steve','alex'].includes(body.type))return fail(reply,400,'只能切换皮肤模型');
      const {readTextureFile,validateTexturePng}=await import('../services/texture.js');const data=await readTextureFile(texture.hash);
      if(!data||!(await validateTexturePng(data,body.type,body.type==='alex')).ok)return fail(reply,400,'图片不支持此模型');
      await exec('UPDATE textures SET type = ? WHERE tid = ?',[body.type,texture.tid]);
      await exec('UPDATE players SET last_modified = ? WHERE tid_skin = ?',[nowString(),texture.tid]);
    }else await setDescription(texture.tid,String(body.description??'').slice(0,65535));
    return {code:0,message:'已更新'};
  });

  const paginate=async(table:string,select:string,where:string,params:any[],request:any)=>{
    const page=Math.max(1,Number(request.query?.page)||1),perPage=Math.min(100,Math.max(1,Number(request.query?.per_page)||20));
    const count=await queryOne<any>(`SELECT COUNT(*) AS total FROM ${table} ${where}`,params);
    const data=await query(`SELECT ${select} FROM ${table} ${where} LIMIT ? OFFSET ?`,[...params,perPage,(page-1)*perPage]);
    return {data,total:count?.total??0,current_page:page,per_page:perPage,last_page:Math.max(1,Math.ceil((count?.total??0)/perPage))};
  };
  for(const [name,table,select]of [['users','users','uid,email,nickname,score,avatar,permission,verified,register_at,last_sign_at'],['players','players','*'],['reports','reports','*']]){
    const list=async(request:any,reply:any)=>isAdmin(request.currentUser)?paginate(table,select,'',[],request):fail(reply,403,'需要管理员权限');
    app.get(`/api/admin/${name}`,list);app.get(`/admin/${name}/list`,list);
  }
  for(const method of ['GET','POST','DELETE'] as const)app.route({method,url:'/api/admin/closet/:uid',handler:async(request,reply)=>{
    if(!isAdmin(request.currentUser))return fail(reply,403,'需要管理员权限');
    const uid=Number((request.params as any).uid);if(method==='GET')return closetOf(uid);
    const body=request.body as any??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    if(method==='POST')return closetAdd(uid,Number(body.tid),String(body.name??''));
    for(const tid of Array.isArray(body.tids)?body.tids:[body.tid])await closetRemove(uid,Number(tid));return{code:0,message:'已更新衣柜'};
  }});

  const notifications=async(request:any)=>paginate('notifications','id,type,data,read_at,created_at','WHERE notifiable_id = ? ORDER BY created_at DESC',[request.currentUser!.uid],request);
  app.get('/api/user/notifications',notifications);
  for(const path of ['/api/user/notifications/:id','/user/notifications/:id'])app.post(path,{config:{legacyWrite:true} as any},async(request,reply)=>{
    if(!request.checkCsrf((request.body as any)?.csrf))return fail(reply,403,'CSRF 校验失败');
    const id=(request.params as any).id;
    await exec(`UPDATE notifications SET read_at = ? WHERE notifiable_id = ?${id==='all'?'':' AND id = ?'}`,[nowString(),request.currentUser!.uid,...(id==='all'?[]:[id])]);
    return{code:0,message:'已标记为已读'};
  });
  const sendNotification=async(request:any,reply:any)=>{
    if(!isAdmin(request.currentUser))return fail(reply,403,'需要管理员权限');
    const body=request.body??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    const message=String(body.message??body.content??'').slice(0,5000);if(!message)return fail(reply,400,'请填写通知内容');
    const ids: number[]=(Array.isArray(body.users)?body.users:body.uid?[body.uid]:[]).map(Number);
    if(!ids.length||ids.length>200)return fail(reply,400,'请选择 1–200 位用户');
    await withTransaction(async()=>{for(const id of [...new Set(ids)])if(Number.isSafeInteger(id)&&id>0)await exec('INSERT INTO notifications (id,type,notifiable_type,notifiable_id,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',[crypto.randomUUID(),'App\\Notifications\\SiteNotification','App\\Models\\User',id,JSON.stringify({title:String(body.title??'站内通知').slice(0,100),message}),nowString(),nowString()]);});
    return{code:0,message:'通知已发送'};
  };
  app.post('/api/admin/notifications',sendNotification);app.post('/admin/notifications/send',{config:{legacyWrite:true} as any},sendNotification);

  const pageContext=async(request:any,title:string)=>({...(await sharedPageContext(request,title))});
  app.get('/user/player/bind',async(request,reply)=>{
    if(!request.currentUser)return reply.redirect('/auth/login?redirect=/user/player/bind');
    if((await listPlayersOfUser(request.currentUser.uid)).length)return reply.redirect('/user/player');
    return reply.view('user/bind-player',{...await pageContext(request,'绑定角色'),error:null});
  });
  app.post('/user/player/bind',{config:{legacyWrite:true} as any},async(request,reply)=>{
    const body=request.body as any??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    const result=await bindSinglePlayer(request.currentUser!.uid,String(body.name??''));
    if(!result.ok)return reply.code(400).view('user/bind-player',{...await pageContext(request,'绑定角色'),error:'角色名不符合要求、已被占用或已绑定角色'});
    return reply.redirect('/user/player');
  });
  for(const name of ['notifications','reports','score-info'])app.get(`/user/${name}`,async(request,reply)=>{
    if(!request.currentUser)return reply.redirect('/auth/login');
    const title=({notifications:'站内通知',reports:'我的举报','score-info':'积分规则'}as any)[name];
    const rows=name==='notifications'?(await notifications(request)).data:name==='reports'?await query('SELECT id,tid,reason,status,report_at FROM reports WHERE reporter = ? ORDER BY id DESC',[request.currentUser.uid]):await Promise.all(['score_per_player','score_per_storage','private_score_per_storage','score_per_closet_item','score_award_per_texture','score_award_per_like','return_score','sign_score'].map(async key=>({规则:key,值:await getOption(key,'0')})));
    return reply.view('user/records',{...await pageContext(request,title),rows});
  });
  app.put('/user/dark-mode',{config:{legacyWrite:true} as any},async(request,reply)=>{
    const body=request.body as any??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    const enabled=body.enabled??body.dark_mode??!request.currentUser!.is_dark_mode;
    await exec('UPDATE users SET is_dark_mode = ? WHERE uid = ?',[enabled===true||enabled==='1'||enabled==='true'?1:0,request.currentUser!.uid]);return{code:0};
  });
  app.post('/user/profile/avatar',{config:{legacyWrite:true} as any},async(request,reply)=>{
    const body=request.body as any??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    const tid=Number(body.tid??body.avatar??0),texture=tid>0?await findTextureByTid(tid):null;
    if(tid>0&&(!texture||texture.type==='cape'||!texture.public&&texture.uploader!==request.currentUser!.uid))return fail(reply,400,'无效头像');
    await exec('UPDATE users SET avatar = ? WHERE uid = ?',[tid,request.currentUser!.uid]);return{code:0,message:'头像已更新'};
  });
  app.get('/.well-known/change-password',async(_request,reply)=>reply.redirect('/user/profile'));
  app.get('/user/oauth/manage',async(_request,reply)=>reply.redirect('/user/connections'));
}
