import crypto from 'node:crypto';
import sharp from 'sharp';
import {exec,queryOne,nowString,withTransaction} from '../db.js';
import {getOption} from './option.js';
import {tokenHash} from './session.js';
import {config} from '../config.js';

const captchaKey=(sid:string)=>tokenHash('captcha:'+sid);
export async function createCaptcha(sid:string,phrase?:string):Promise<Buffer>{
  const letters='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const answer=phrase??Array.from(crypto.randomBytes(5),byte=>letters[byte%letters.length]).join('');
  if(!/^[A-Z2-9]{5}$/.test(answer))throw new Error('Invalid CAPTCHA phrase');
  await exec('INSERT INTO mcn_oauth_flows (token_hash,browser_hash,stage,payload,expires_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),expires_at=VALUES(expires_at)',[captchaKey(sid),tokenHash(sid),'captcha',JSON.stringify({hash:tokenHash(sid+':'+answer.toUpperCase())}),nowString(600)]);
  const glyphs=[...answer].map((letter,index)=>`<text x="${10+index*19}" y="28" transform="rotate(${crypto.randomInt(-12,13)} ${10+index*19} 28)">${letter}</text>`).join('');
  const lines=Array.from({length:4},()=>`<path d="M0 ${crypto.randomInt(5,36)} Q60 ${crypto.randomInt(2,36)} 120 ${crypto.randomInt(5,36)}" fill="none" stroke="#8d9baf" stroke-width="1"/>`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#eef1f5"/>${lines}<g font-family="sans-serif" font-size="25" font-weight="700" fill="#27384e">${glyphs}</g></svg>`)).jpeg({quality:85}).toBuffer();
}
export async function verifyCaptcha(sid:string,value:unknown,ip:string):Promise<boolean>{
  const answer=typeof value==='string'?value.trim():'';if(!answer||answer.length>4096)return false;
  const secret=await getOption('recaptcha_secretkey','');
  if(secret){
    try{
      const endpoint=await getOption('recaptcha_verify_url','https://www.recaptcha.net/recaptcha/api/siteverify'),url=new URL(endpoint);
      const local=process.env.NODE_ENV!=='production'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
      if(url.username||url.password||url.protocol!=='https:'&&!(local&&url.protocol==='http:'))return false;
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret,response:answer,remoteip:ip}),redirect:'error',signal:AbortSignal.timeout(5000)});
      const result:any=response.ok?await response.json():null;
      if(result?.hostname){const site=new URL(config.publicOrigin||await getOption('site_url','http://localhost'));if(result.hostname!==site.hostname)return false;}
      return result?.success===true;
    }catch{return false;}
  }
  return withTransaction(async()=>{
    const row=await queryOne<{payload:string}>('SELECT payload FROM mcn_oauth_flows WHERE token_hash=? AND browser_hash=? AND stage=? AND expires_at>? FOR UPDATE',[captchaKey(sid),tokenHash(sid),'captcha',nowString()]);
    if(!row)return false;
    await exec('DELETE FROM mcn_oauth_flows WHERE token_hash=?',[captchaKey(sid)]);
    let hash:string;try{hash=JSON.parse(row.payload).hash;}catch{return false;}
    const actual=tokenHash(sid+':'+answer.toUpperCase());return typeof hash==='string'&&hash.length===actual.length&&crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(actual));
  });
}
export async function loginFailures(ip:string):Promise<number>{
 const row=await queryOne<{payload:string}>('SELECT payload FROM mcn_oauth_flows WHERE token_hash=? AND stage=? AND expires_at>?',[tokenHash('login-fails:'+ip),'login-fails',nowString()]);
 try{return Number(row&&JSON.parse(row.payload).count)||0;}catch{return 0;}
}
export async function recordLoginFailure(ip:string):Promise<void>{
 await exec('INSERT INTO mcn_oauth_flows (token_hash,browser_hash,stage,payload,expires_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=JSON_SET(payload,\'$.count\',IF(expires_at>?,COALESCE(JSON_EXTRACT(payload,\'$.count\'),0),0)+1),expires_at=VALUES(expires_at)',[tokenHash('login-fails:'+ip),tokenHash(ip),'login-fails','{"count":1}',nowString(3600),nowString()]);
}
export async function clearLoginFailures(ip:string):Promise<void>{await exec('DELETE FROM mcn_oauth_flows WHERE token_hash=? AND stage=?',[tokenHash('login-fails:'+ip),'login-fails']);}
