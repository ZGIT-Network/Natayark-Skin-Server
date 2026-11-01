import crypto from 'node:crypto';
import {config} from '../config.js';
import {exec,queryOne,nowString} from '../db.js';
import {tokenHash} from './session.js';

export type JoinSession={profile:string;name:string;ip:string;accessToken:string};
export const joinSessionKey=(serverId:string,profile:string)=>tokenHash('ygg-join:'+JSON.stringify([serverId,profile]));
const encryptionKey=()=>crypto.createHash('sha256').update('natayark:join:v1:'+config.appKey).digest();

/** Shared database state; a stored record never exposes a reusable bearer token. */
export async function putJoinSession(serverId:string,session:JoinSession):Promise<void>{
  const key=joinSessionKey(serverId,session.profile),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),nonce);
  cipher.setAAD(Buffer.from(key));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(session),'utf8'),cipher.final()]);
  const payload=JSON.stringify({version:1,nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:encrypted.toString('base64url')});
  await exec('INSERT INTO mcn_oauth_flows (token_hash,browser_hash,stage,payload,expires_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),expires_at=VALUES(expires_at)',[key,tokenHash('ygg-join'),'ygg-join',payload,nowString(30)]);
  await exec('DELETE FROM mcn_oauth_flows WHERE stage=? AND expires_at<=? LIMIT 500',['ygg-join',nowString()]);
}
export async function getJoinSession(serverId:string,profile:string):Promise<JoinSession|null>{
  const key=joinSessionKey(serverId,profile),row=await queryOne<{payload:string}>('SELECT payload FROM mcn_oauth_flows WHERE token_hash=? AND stage=? AND expires_at>?',[key,'ygg-join',nowString()]);
  if(!row||row.payload.length>65536)return null;
  try{
    const sealed=JSON.parse(row.payload);if(sealed.version!==1)return null;
    const nonce=Buffer.from(sealed.nonce,'base64url'),tag=Buffer.from(sealed.tag,'base64url');if(nonce.length!==12||tag.length!==16)return null;
    const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),nonce);decipher.setAAD(Buffer.from(key));decipher.setAuthTag(tag);
    const session=JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64url')),decipher.final()]).toString('utf8'));
    if(session.profile!==profile||![session.profile,session.name,session.ip,session.accessToken].every(value=>typeof value==='string'))return null;
    return session;
  }catch{return null;}
}
