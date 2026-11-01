import crypto from 'node:crypto';
import { afterCommit, query } from '../db.js';
import { getOption, getOptionInt } from './option.js';
import { pluginEnabled } from './plugins.js';

const quoteCache=new Map<string,{text:string;expires:number}>();
export async function dailyQuote(): Promise<{text:string;source:string;stale:boolean}> {
  const source=await getOption('hitokoto_api','https://v1.hitokoto.cn?encode=text');
  const cached=quoteCache.get(source);
  if(cached&&cached.expires>Date.now())return{text:cached.text,source,stale:false};
  try{
    const url=new URL(source),local=process.env.NODE_ENV!=='production'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw new Error('Invalid quote endpoint');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(2500)});
    if(!response.ok)throw new Error('Quote source unavailable');
    if(Number(response.headers.get('content-length'))>65536)throw new Error('Quote response too large');
    const content=await response.text();if(content.length>65536)throw new Error('Quote response too large');
    let text=content;if(response.headers.get('content-type')?.includes('json'))text=JSON.parse(content).hitokoto;
    if(typeof text!=='string'||!text.trim())throw new Error('Empty quote');
    text=text.trim().replace(/\s+/g,' ').slice(0,256);
    quoteCache.set(source,{text,expires:Date.now()+Math.max(60,Math.min(86400,await getOptionInt('hitokoto_cache_seconds',300)))*1000});
    return{text,source,stale:false};
  }catch{return{text:cached?.text??await getOption('hitokoto_fallback',''),source,stale:true};}
}

const encode=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
export function signedCdnRefreshUrl(endpoint:string,params:Record<string,string>,secret:string,method='GET'):string{
  const canonical=Object.keys(params).sort().map(key=>encode(key)+'='+encode(params[key])).join('&');
  const signature=crypto.createHmac('sha1',secret+'&').update(method+'&%2F&'+encode(canonical)).digest('base64');
  const url=new URL(endpoint);url.search=new URLSearchParams({...params,Signature:signature}).toString();return url.toString();
}
export async function profileRefreshUrls(names:string[],base:string,knownUuids?:Map<string,string[]>):Promise<string[]>{
  const urls=new Set<string>(),plugins=await Promise.all(['usm-api','legacy-api','yggdrasil-api'].map(pluginEnabled));
  for(const name of new Set(names)){
    const encoded=encodeURIComponent(name),root=base.replace(/\/+$/,'');
    urls.add(root+'/'+encoded+'.json');urls.add(root+'/csl/'+encoded+'.json');
    if(plugins[0])urls.add(root+'/usm/'+encoded+'.json');
    if(plugins[1]){urls.add(root+'/skin/'+encoded+'.png');urls.add(root+'/cape/'+encoded+'.png');}
    if(plugins[2])for(const uuid of new Set([...(knownUuids?.get(name)??[]),...(await query<{uuid:string}>('SELECT uuid FROM `uuid` WHERE name=?',[name])).map(row=>row.uuid)])){
      const path=root+'/api/yggdrasil/sessionserver/session/minecraft/profile/'+uuid;
      urls.add(path);urls.add(path+'?unsigned=false');urls.add(path+'?unsigned=true');
    }
  }
  return [...urls];
}
export async function queueProfileRefresh(...names:string[]):Promise<void>{
  if(!process.env.ALICDN_SITE_BASE_URL||!process.env.ALICDN_ACCESSKEY_ID||!process.env.ALICDN_ACCESSKEY_SECRET||!await pluginEnabled('refresh-ali-cdn'))return;
  const knownUuids=new Map<string,string[]>();
  for(const name of new Set(names))knownUuids.set(name,(await query<{uuid:string}>('SELECT uuid FROM `uuid` WHERE name=?',[name])).map(row=>row.uuid));
  afterCommit(async()=>{
    const base=process.env.ALICDN_SITE_BASE_URL,id=process.env.ALICDN_ACCESSKEY_ID,secret=process.env.ALICDN_ACCESSKEY_SECRET;
    if(!base||!id||!secret||!await pluginEnabled('refresh-ali-cdn'))return;
    const endpoint=process.env.ALICDN_API_ENDPOINT||'https://cdn.aliyuncs.com/';
    const url=new URL(endpoint),local=process.env.NODE_ENV!=='production'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    // Isolated validation must never purge a production CDN.
    if(process.env.DB_TABLE_PREFIX&&!local)return;
    if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))return;
    const paths=await profileRefreshUrls(names,base,knownUuids);
    try{
      for(let offset=0;offset<paths.length;offset+=100){
        const params={Action:'RefreshObjectCaches',ObjectPath:paths.slice(offset,offset+100).join('\n'),ObjectType:'File',Format:'JSON',Version:'2018-05-10',AccessKeyId:id,SignatureMethod:'HMAC-SHA1',SignatureNonce:crypto.randomBytes(16).toString('hex'),SignatureVersion:'1.0',Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
        const signed=new URL(signedCdnRefreshUrl(endpoint,params,secret,'POST')),body=signed.searchParams.toString();signed.search='';
        const response=await fetch(signed,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('CDN service rejected refresh');
        const result:any=await response.json();if(result.Code)throw new Error('CDN service rejected refresh');
      }
    }catch{console.warn('CDN refresh failed after a committed profile change.');}
  });
}
export async function queueTextureProfileRefresh(tid:number,uid?:number):Promise<void>{
  if(!process.env.ALICDN_SITE_BASE_URL||!process.env.ALICDN_ACCESSKEY_ID||!process.env.ALICDN_ACCESSKEY_SECRET)return;
  const players=await query<{name:string}>('SELECT name FROM players WHERE (tid_skin=? OR tid_cape=?)'+(uid===undefined?'':' AND uid=?'),[tid,tid,...(uid===undefined?[]:[uid])]);
  if(players.length)await queueProfileRefresh(...players.map(player=>player.name));
}
