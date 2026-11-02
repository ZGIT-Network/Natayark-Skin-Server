import type { FastifyInstance } from 'fastify';
import { queryOne, nowString } from '../db.js';
import { isAdmin, findUserByUid } from '../services/user.js';
import { closetOf } from '../services/texture.js';
import { siteChart, pageNumber } from '../services/site-data.js';
import { pageContext } from './page-context.js';
import { requestEmailChange } from './auth.js';
import { dailyQuote } from '../services/integrations.js';
import { pluginEnabled } from '../services/plugins.js';
import {systemStatus} from '../services/system-status.js';

export async function registerManagementRoutes(app: FastifyInstance, handlers: Map<string,any>) {
  app.get('/user/quote',async(request,reply)=>{
    if(!request.currentUser)return reply.code(401).send({code:1,message:'请先登录'});
    if(!await pluginEnabled('hitokoto'))return reply.code(204).send();
    return dailyQuote();
  });
  const admin = (request:any,reply:any) => {
    if (isAdmin(request.currentUser)) return true;
    if (!request.currentUser) reply.redirect('/auth/login?redirect=' + encodeURIComponent(request.url));
    else reply.redirect('/user?notice=permission-denied');
    return false;
  };
  const authError = async(request:any,reply:any,message:string,status=400) => reply.code(status).view('error',{...await pageContext(request,'邮箱验证'),code:status,message});
  app.get('/auth/bind',async(request,reply)=>{
    if(!request.currentUser)return reply.redirect('/auth/login?redirect=/auth/bind');
    if(request.currentUser.email)return reply.redirect('/user/profile');
    return reply.view('auth/bind',{...await pageContext(request,'补填邮箱')});
  });
  app.post('/auth/bind',async(request,reply)=>{
    if(!request.currentUser)return reply.redirect('/auth/login?redirect=/auth/bind');
    const user=request.currentUser,body=request.body as any??{};
    if(!request.checkCsrf(body.csrf??body._token))return authError(request,reply,'会话已过期，请刷新后重试',403);
    if(user.email)return authError(request,reply,'已有邮箱的账户请在个人资料中修改邮箱',403);
    const email=String(body.email??'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>100)return authError(request,reply,'请输入有效的邮箱');
    if(await queryOne('SELECT uid FROM users WHERE email=?',[email]))return authError(request,reply,'该邮箱已被使用');
    if(await queryOne('SELECT token_hash FROM mcn_email_challenges WHERE user_id=? AND purpose=? AND created_at>?',[user.uid,'email-change',nowString(-180)]))return authError(request,reply,'验证邮件已发送，请稍后再试',429);
    const sent=await requestEmailChange(user.uid,email);
    return reply.view('auth/notice',{...await pageContext(request,'验证邮箱'),message:sent?'验证邮件已发送。请在当前浏览器中打开邮件链接，验证后才会保存新邮箱。':'邮件服务不可用，请联系管理员'});
  });
  app.post('/user/email-verification',async(request,reply)=>{
    const body=request.body as any??{};if(body.csrf===undefined&&body._token!==undefined)body.csrf=body._token;
    return handlers.get('POST /auth/verify-email/send').call(app,request,reply);
  });
  for(const method of ['GET','POST'] as const)app.route({method,url:'/auth/verify/:uid',handler:async(request,reply)=>{
    const uid=Number((request.params as any).uid),body=request.body as any??{},token=String((request.query as any).token??body.token??'');
    if(!Number.isSafeInteger(uid)||uid<=0)return authError(request,reply,'验证链接无效');
    if(token){
      const {tokenHash}=await import('../services/session.js');
      const challenge=await queryOne<{user_id:number}>('SELECT user_id FROM mcn_email_challenges WHERE token_hash=?',[tokenHash(token)]);
      if(!challenge||challenge.user_id!==uid)return authError(request,reply,'旧验证链接已失效，请重新发送验证邮件');
      request.query={token};return handlers.get('GET /auth/verify-email').call(app,request,reply);
    }
    if(request.currentUser?.uid!==uid)return reply.redirect('/auth/login?redirect=' + encodeURIComponent('/auth/verify/'+uid));
    if(!request.currentUser.email)return reply.redirect('/auth/bind');
    if(method==='POST')return handlers.get('POST /auth/verify-email/send').call(app,request,reply);
    return reply.view('auth/verify',{...await pageContext(request,'验证邮箱')});
  }});
  for (const [path,tab] of [['customize','appearance'],['score','score'],['options','basic'],['resource','basic']]) {
    app.get('/admin/' + path,async(request,reply) => admin(request,reply) ? reply.redirect('/admin/settings#' + tab) : undefined);
    app.post('/admin/' + path,{config:{legacyWrite:true} as any},async(request,reply) => {
      const handler = handlers.get('POST /admin/settings');
      return handler.call(app,request,reply);
    });
  }
  app.get('/admin/chart',async(request,reply) => {
    if (!isAdmin(request.currentUser)) return reply.code(request.currentUser ? 403 : 401).send({code:1,message:'需要管理员权限'});
    return siteChart();
  });
  app.get('/admin/status',async(request,reply) => {
    if (!admin(request,reply)) return;
    const runtime=await systemStatus(app.version);
    return reply.view('admin/status',{...await pageContext(request,'系统状态'),runtime,mailConfigured:runtime.mailConfigured});
  });
  app.get('/admin/closet/:uid',async(request,reply) => {
    if (!admin(request,reply)) return;
    const owner = await findUserByUid(Number((request.params as any).uid));
    if (!owner) return reply.code(404).view('error',{...await pageContext(request,'用户不存在'),code:404,message:'用户不存在'});
    const q = request.query as Record<string,string>;
    const keyword = String(q.q ?? '').trim().slice(0,100), type = ['skin','cape','steve','alex'].includes(q.type) ? q.type : '';
    const items = (await closetOf(owner.uid)).filter(item => (!type || item.type === type || type === 'skin' && item.type !== 'cape') && (!keyword || item.item_name.toLowerCase().includes(keyword.toLowerCase())));
    const page = pageNumber(q.page);
    return reply.view('admin/closet',{...await pageContext(request,'管理衣柜'),owner,closet:items.slice((page - 1) * 20,page * 20),total:items.length,page,pages:Math.max(1,Math.ceil(items.length / 20)),keyword,type});
  });
  app.get('/admin/notifications',async(request,reply) => {
    if (!admin(request,reply)) return;
    return reply.view('admin/notifications',{...await pageContext(request,'发送站内通知')});
  });
}
