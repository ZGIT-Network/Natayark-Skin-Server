import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { query, queryOne, exec, withTransaction } from '../db.js';
import { createClient } from '../services/oidc.js';
import { issueAccessToken, getSystemClientId, revokeTokenRow, safeParseScopes } from '../services/token.js';
import { pageContext } from './page-context.js';
import { isAdmin } from '../services/user.js';

const USER_SCOPES = {
  'User.Read':'读取账户资料','Player.Read':'读取角色','Player.ReadWrite':'管理角色',
  'Closet.Read':'读取衣柜','Closet.ReadWrite':'管理衣柜','Notification.Read':'读取站内通知','Notification.ReadWrite':'发送站内通知（需管理员）',
};
const ADMIN_SCOPES = {
  'UsersManagement.Read':'读取用户列表','UsersManagement.ReadWrite':'管理用户',
  'PlayersManagement.Read':'读取全站角色','PlayersManagement.ReadWrite':'管理全站角色',
  'ClosetManagement.Read':'读取用户衣柜','ClosetManagement.ReadWrite':'管理用户衣柜',
  'ReportsManagement.Read':'读取举报','ReportsManagement.ReadWrite':'审核举报',
};
const scopesFor = (user:any) => Object.entries({...USER_SCOPES,...(isAdmin(user) ? ADMIN_SCOPES : {})}).map(([id,description])=>({id,description}));

export function validateRedirects(input: unknown): string[] | null {
  const redirects=String(input??'').split(/[\r\n,]+/).map(s=>s.trim()).filter(Boolean);
  if(!redirects.length||redirects.length>10)return null;
  for(const redirect of redirects){
    try{const url=new URL(redirect);
      if(url.hash||url.username||url.password||['javascript:','data:','file:','ftp:'].includes(url.protocol))return null;
      if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return null;
      if(!['http:','https:'].includes(url.protocol)&&!/^[-a-zA-Z0-9+.]+:$/.test(url.protocol))return null;
    }catch{return null;}
  }
  return [...new Set(redirects)];
}

export async function registerApplicationRoutes(app: FastifyInstance): Promise<void>{
  const fail=(reply:any,status:number,message:string)=>reply.code(status).send({code:1,message});
  const owned=async(request:any,id:string)=>queryOne<any>('SELECT * FROM oauth_clients WHERE id = ? AND user_id = ? AND revoked = 0',[id,request.currentUser.uid]);
  const guard=async(request:any,reply:any)=>{
    if(!request.currentUser||request.currentUser.permission<0){fail(reply,401,'请先登录');return false;}
    if(!['GET','HEAD'].includes(request.method)&&!request.checkCsrf(request.body?.csrf??request.body?._token??request.headers['x-csrf-token'])){fail(reply,403,'CSRF 校验失败');return false;}return true;
  };
  app.get('/user/applications',async(request,reply)=>{
    if(!request.currentUser)return reply.redirect('/auth/login?redirect=/user/applications');
    if(!await guard(request,reply))return;
    const clients=await query('SELECT id,name,secret,redirect FROM oauth_clients WHERE user_id = ? AND revoked = 0',[request.currentUser!.uid]);
    const tokens=await query('SELECT id,name,scopes,created_at,expires_at FROM oauth_access_tokens WHERE user_id = ? AND revoked = 0 AND name = ?',[request.currentUser!.uid,'Personal Access Token']);
    return reply.view('user/applications',{...(await pageContext(request,'开发者应用')),clients,tokens:tokens.map((token:any)=>({...token,scopes:safeParseScopes(token.scopes)})),availableScopes:scopesFor(request.currentUser)});
  });
  const list=async(request:any,reply:any)=>await guard(request,reply)?query('SELECT id,name,secret,redirect,created_at,updated_at FROM oauth_clients WHERE user_id = ? AND revoked = 0',[request.currentUser!.uid]):undefined;
  app.get('/oauth/clients',list);
  app.post('/oauth/clients',async(request,reply)=>{
    if(!await guard(request,reply))return;
    const body=request.body as any??{},redirects=validateRedirects(body.redirect);
    if(!redirects||!String(body.name??'').trim())return fail(reply,400,'请输入应用名称与有效的回调 URI');
    const secret=body.public_client==='1'||body.public_client===true?null:crypto.randomBytes(32).toString('hex');
    const id=await createClient({name:String(body.name).slice(0,100),secret,redirects,ownerId:request.currentUser!.uid});
    return{code:0,id,secret,redirect:redirects.join(',')};
  });
  app.put('/oauth/clients/:id',async(request,reply)=>{
    if(!await guard(request,reply))return;
    const id=(request.params as any).id,client=await owned(request,id),body=request.body as any??{},redirects=validateRedirects(body.redirect);
    if(!client)return fail(reply,404,'应用不存在');if(!redirects||!String(body.name??'').trim())return fail(reply,400,'名称或回调 URI 无效');
    await exec('UPDATE oauth_clients SET name = ?, redirect = ? WHERE id = ?',[String(body.name).slice(0,100),redirects.join(','),id]);return{code:0,message:'已更新应用'};
  });
  app.delete('/oauth/clients/:id',async(request,reply)=>{
    if(!await guard(request,reply))return;
    const id=(request.params as any).id;if(!await owned(request,id))return fail(reply,404,'应用不存在');
    await withTransaction(async()=>{await exec('UPDATE oauth_clients SET revoked = 1 WHERE id = ?',[id]);await exec('UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ?',[id]);});return{code:0,message:'已撤销应用'};
  });
  app.get('/oauth/personal-access-tokens',async(request,reply)=>await guard(request,reply)?query('SELECT id,name,scopes,created_at,expires_at FROM oauth_access_tokens WHERE user_id = ? AND revoked = 0 AND name = ?',[request.currentUser!.uid,'Personal Access Token']):undefined);
  app.post('/oauth/personal-access-tokens',async(request,reply)=>{
    if(!await guard(request,reply))return;
    const body=request.body as any??{},scopes=Array.isArray(body.scopes)?body.scopes:[];
    const allowed=scopesFor(request.currentUser).map(scope=>scope.id);
    if(!scopes.length||scopes.some((s:any)=>!allowed.includes(s)))return fail(reply,400,'权限范围无效');
    const token=await issueAccessToken({userId:request.currentUser!.uid,clientId:await getSystemClientId(),scopes});
    await exec('UPDATE oauth_access_tokens SET name = ? WHERE id = ?',['Personal Access Token',token.jti]);
    reply.header('Cache-Control','private, no-store');
    return{code:0,accessToken:token.jwt,token:{id:token.jti,name:'Personal Access Token',scopes}};
  });
  app.delete('/oauth/personal-access-tokens/:id',async(request,reply)=>{
    if(!await guard(request,reply))return;
    const row=await queryOne<any>('SELECT id FROM oauth_access_tokens WHERE id = ? AND user_id = ? AND name = ?',[(request.params as any).id,request.currentUser!.uid,'Personal Access Token']);
    if(!row)return fail(reply,404,'令牌不存在');await revokeTokenRow(row.id);return{code:0,message:'已撤销令牌'};
  });
  app.get('/oauth/scopes',async(request,reply)=>await guard(request,reply)?scopesFor(request.currentUser):undefined);
}
