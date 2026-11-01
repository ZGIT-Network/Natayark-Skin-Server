import crypto from 'node:crypto';
import {config} from '../config.js';
import {compileSearch,SearchError,type SearchEntity} from '../services/search.js';
import type { FastifyInstance } from 'fastify';
import { query, queryOne, exec, nowString, withTransaction, insert } from '../db.js';
import { getOption, getOptionInt, getOptionBool } from '../services/option.js';
import { isAdmin } from '../services/user.js';
import { pageContext as sharedPageContext } from './page-context.js';
import { listPlayersOfUser, bindSinglePlayer, findPlayerByPid, clearPlayerTexture } from '../services/player.js';
import { closetOf, closetAdd, closetRemove, findTextureByTid, skinlibSearch, textureNameValid, getDescription, setDescription } from '../services/texture.js';
import { setPlayerTexture } from '../services/player.js';
import { findUserByUid } from '../services/user.js';
import { renderMarkdown, validateDescription } from '../services/content.js';
import { notificationInbox, notificationView, readNotification, sendSiteNotification, pageNumber } from '../services/site-data.js';
import { queueTextureProfileRefresh } from '../services/integrations.js';

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
    if (url.startsWith('/api/skinlib') && !url.endsWith('/report') && !url.endsWith('/description')) alias(method,url.replace('/api/skinlib','/texture'),url);
  }
  for (const prefix of ['/admin','/api/admin']) {
    for (const field of ['email','verification','nickname','password','score','permission']) alias('PUT',`${prefix}/users/:uid/${field}`,'/api/admin/user/:uid',r=>{
      const body=r.body??{};r.body={...body,field:field==='verification'?'verified':field,value:body.value??body[field]??(field==='verification'?body.verified:'')};
    });
    alias('DELETE',`${prefix}/users/:uid`,'/api/admin/user/:uid');
    for (const field of ['name','owner']) alias('PUT',`${prefix}/players/:pid/${field}`,'/api/admin/player/:pid',r=>{const body=r.body??{};r.body={...body,field,value:body.value??(field==='name'?body.player_name:body.uid)??body[field]};});
    app.put(`${prefix}/players/:pid/textures`,{config:{legacyWrite:true} as any},async(request,reply)=>{
      if(!isAdmin(request.currentUser))return fail(reply,403,'需要管理员权限');
      const body=request.body as any??{};
      if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
      const player=await findPlayerByPid(Number((request.params as any).pid));
      if(!player)return fail(reply,404,'角色不存在');
      const tid=Number(body.tid),type=body.type;
      if(!['skin','cape'].includes(type)||!Number.isSafeInteger(tid)||tid<0)return fail(reply,422,'请选择材质类型与有效的 TID');
      if(tid===0)await clearPlayerTexture(player,type);
      else{
        const texture=await findTextureByTid(tid);
        if(!texture||(type==='cape')!==(texture.type==='cape'))return fail(reply,422,'材质不存在或类型不符');
        await setPlayerTexture(player,type,tid);
      }
      return{code:0,message:'角色材质已更新'};
    });
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
    const type=q.type??q.category??'skin', page=pageNumber(q.page), perPage=pageNumber(q.perPage??q.per_page,6,100);
    const filtered=items.filter(i=>(type==='all'||i.type===type||type==='skin'&&i.type!=='cape')&&(!q.q||i.item_name.toLowerCase().includes(String(q.q).toLowerCase())));
    return {data:filtered.slice((page-1)*perPage,page*perPage),total:filtered.length,current_page:page,per_page:perPage,last_page:Math.max(1,Math.ceil(filtered.length/perPage))};
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
    reply.header('Cache-Control','private, no-store');
    const item=await findTextureByTid(Number(request.params.tid));
    if(!item)return fail(reply,404,'材质不存在');
    if(!item.public&&item.uploader!==request.currentUser?.uid&&!isAdmin(request.currentUser)){
      const hidden=await getOptionInt('status_code_for_private',403)===404;
      return fail(reply,hidden?404:403,hidden?'材质不存在':'无权访问私有材质');
    }
    return {...item,description:await getDescription(item.tid)};
  };
  app.get('/texture/:tid',textureInfo); app.get('/skinlib/info/:tid',textureInfo);
  for(const prefix of ['/texture','/api/textures']){
    app.get(`${prefix}/:tid/description`,{config:{publicApi:true} as any},async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      const texture=await findTextureByTid(Number((request.params as any).tid));
      if(!texture)return fail(reply,404,'材质不存在');
      if(!texture.public&&texture.uploader!==request.currentUser?.uid&&!isAdmin(request.currentUser)){
        const hidden=await getOptionInt('status_code_for_private',403)===404;
        return fail(reply,hidden?404:403,hidden?'材质不存在':'无权访问该材质');
      }
      const description=await getDescription(texture.tid);
      if(Object.hasOwn(request.query as object,'raw'))return reply.type('text/markdown; charset=utf-8').send(description);
      return reply.type('text/html; charset=utf-8').send(renderMarkdown(description));
    });
    app.put(`${prefix}/:tid/description`,{config:{legacyWrite:true} as any},async(request,reply)=>{
      const body=request.body as any??{};
      if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
      const texture=await findTextureByTid(Number((request.params as any).tid));
      if(!texture)return fail(reply,404,'材质不存在');
      if(texture.uploader!==request.currentUser?.uid&&!isAdmin(request.currentUser))return fail(reply,403,'无权修改该材质');
      let description:string;
      try{description=await validateDescription(body.description);}catch(error:any){return fail(reply,422,error.message);}
      await setDescription(texture.tid,description);
      return reply.type('text/html; charset=utf-8').send(renderMarkdown(description));
    });
  }
  app.get('/skinlib/list',async request=>{
    const q=request.query as any,page=pageNumber(q.page),perPage=pageNumber(q.per_page,20,100);
    const result=await skinlibSearch({keyword:String(q.q??q.keyword??'').slice(0,100),type:q.filter??q.type??'skin',status:q.status,sort:q.sort,uploader:pageNumber(q.uploader,0),page,perPage,viewer:request.currentUser?{uid:request.currentUser.uid,admin:isAdmin(request.currentUser)}:null});
    return {...result,data:result.items.map((item:any)=>({...item,nickname:item.uploader_name})),current_page:page,per_page:perPage,last_page:Math.max(1,Math.ceil(result.total/perPage))};
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
      await queueTextureProfileRefresh(texture.tid);
    }else await setDescription(texture.tid,String(body.description??'').slice(0,65535));
    return {code:0,message:'已更新'};
  });

  const paginate=async(table:string,select:string,where:string,params:any[],request:any)=>{
    const page=pageNumber(request.query?.page),perPage=pageNumber(request.query?.per_page,20,100);
    const count=await queryOne<any>(`SELECT COUNT(*) AS total FROM ${table} ${where.replace(/ ORDER BY .+$/i,'')}`,params);
    const data=await query(`SELECT ${select} FROM ${table} ${where} LIMIT ? OFFSET ?`,[...params,perPage,(page-1)*perPage]);
    return {data,total:count?.total??0,current_page:page,per_page:perPage,last_page:Math.max(1,Math.ceil((count?.total??0)/perPage))};
  };
  for(const [name,table,select]of [['users','users','uid,email,nickname,score,avatar,permission,verified,register_at,last_sign_at'],['players','players','*'],['reports','reports','*']]){
    const list=async(request:any,reply:any)=>{
      if(!isAdmin(request.currentUser))return fail(reply,403,'需要管理员权限');
      try{
        const expression=String(request.query?.q??request.query?.keyword??'').trim();
        const search=compileSearch(name as SearchEntity,expression,{numericIds:request.query?.q===undefined,timezone:config.tz});
        const projection=search.fields?search.fields.map(field=>'`'+field+'`').join(','):select;
        // As in Eloquent paginate(), endpoint pagination overrides SearchString limit/from.
        return await paginate(table,projection,search.where+' ORDER BY '+search.orderBy,search.params,request);
      }catch(error){if(error instanceof SearchError)return fail(reply,422,error.message);throw error;}
    };
    app.get(`/api/admin/${name}`,list);app.get(`/admin/${name}/list`,list);
  }
  for(const path of ['/api/admin/closet/:uid','/admin/closet/:uid'])for(const method of (path.startsWith('/api')?['GET','POST','DELETE']:['POST','DELETE']) as Array<'GET'|'POST'|'DELETE'>)app.route({method,url:path,config:{legacyWrite:method!=='GET'} as any,handler:async(request,reply)=>{
    if(!isAdmin(request.currentUser))return fail(reply,403,'需要管理员权限');
    const uid=Number((request.params as any).uid);
    if(!await findUserByUid(uid))return fail(reply,404,'用户不存在');
    if(method==='GET')return closetOf(uid);
    const body=request.body as any??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    if(method==='POST'){
      const result=await closetAdd(uid,Number(body.tid),String(body.name??''));
      if(!result.ok)return fail(reply,result.reason==='not_found'?404:400,({dup:'衣柜中已有该材质',lack_score:'用户积分不足',not_found:'材质不存在或不可访问'} as any)[result.reason!]);
      return{code:0,message:'已添加到用户衣柜'};
    }
    const tids=(Array.isArray(body.tids)?body.tids:[body.tid]).map(Number);
    if(!tids.length||tids.some((tid:number)=>!Number.isSafeInteger(tid)||tid<=0))return fail(reply,422,'请填写有效的 TID');
    await withTransaction(async()=>{for(const tid of tids)await closetRemove(uid,tid);});return{code:0,message:'已更新衣柜'};
  }});

  const notifications=async(request:any)=>{
    const rows=await query<any>('SELECT id,data,read_at,created_at FROM notifications WHERE notifiable_id=? AND notifiable_type IN (?,?) AND read_at IS NULL ORDER BY created_at DESC',[request.currentUser!.uid,'App\\Models\\User','App\\User']);
    return rows.map(notificationView).map(({id,title})=>({id,title}));
  };
  app.get('/api/user/notifications',notifications);
  for(const path of ['/api/user/notifications/:id','/user/notifications/:id'])app.post(path,{config:{legacyWrite:true} as any},async(request,reply)=>{
    if(!request.checkCsrf((request.body as any)?.csrf))return fail(reply,403,'CSRF 校验失败');
    const id=(request.params as any).id;
    if(id==='all'){
      await exec('UPDATE notifications SET read_at=?,updated_at=? WHERE notifiable_id=? AND notifiable_type IN (?,?) AND read_at IS NULL',[nowString(),nowString(),request.currentUser!.uid,'App\\Models\\User','App\\User']);
      return{code:0,message:'已全部标记为已读'};
    }
    const notification=await readNotification(request.currentUser!.uid,id);
    if(!notification)return fail(reply,404,'通知不存在');
    return{code:0,message:'已标记为已读',...notification};
  });
  const sendNotification=async(request:any,reply:any)=>{
    if(!isAdmin(request.currentUser))return fail(reply,403,'需要管理员权限');
    const body=request.body??{};if(!request.checkCsrf(body.csrf))return fail(reply,403,'CSRF 校验失败');
    try{return{code:0,message:'通知已发送',sent:await sendSiteNotification(body)};}
    catch(error:any){return fail(reply,422,error.message);}
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
    const q=request.query as Record<string,string>,page=pageNumber(q.page);
    if(name==='notifications')return reply.view('user/notifications',{...await pageContext(request,title),...await notificationInbox(request.currentUser.uid,page,q.filter==='unread'),filter:q.filter==='unread'?'unread':'all'});
    if(name==='reports'){
      const result=await paginate('reports r LEFT JOIN textures t ON t.tid=r.tid','r.id,r.tid,r.reason,r.status,r.report_at,t.name AS texture_name','WHERE r.reporter=? ORDER BY r.id DESC',[request.currentUser.uid],request);
      return reply.view('user/reports',{...await pageContext(request,title),rows:result.data,page:result.current_page,pages:result.last_page,total:result.total});
    }
    const rules=Object.fromEntries(await Promise.all(['score_per_player','score_per_storage','private_score_per_storage','score_per_closet_item','score_award_per_texture','score_award_per_like','reporter_score_modification','reporter_reward_score','return_score','sign_score','sign_gap_time','sign_after_zero'].map(async key=>[key,(await getOption(key))??'0'])));
    return reply.view('user/score',{...await pageContext(request,title),rules});
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
  app.get('/user/oauth/manage',async(_request,reply)=>reply.redirect('/user/applications'));
}
