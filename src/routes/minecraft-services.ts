import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, SCOPES } from '../services/token.js';
import { profileFromUuid, type YggProfile } from '../services/profile.js';
import { FriendsError, friendsList, friendTarget, updateFriend, socialPreferences, updateSocialPreferences, presence, PRESENCE_STATUSES, type PresenceStatus, type SocialProfile } from '../services/friends.js';

type SocialRequest = FastifyRequest & { socialActor: YggProfile; socialToken: string };
const privileges = { onlineChat:{enabled:true},multiplayerServer:{enabled:true},multiplayerRealms:{enabled:false},telemetry:{enabled:false},optionalTelemetry:{enabled:false} };
function attributes(preferences: SocialProfile) {
  return { privileges,profanityFilterPreferences:{profanityFilterOn:!!preferences.profanity_filter},
    friendsPreferences:{friends:preferences.friends_enabled?'ENABLED':'DISABLED',acceptInvites:preferences.accept_invites?'ENABLED':'DISABLED'},
    chatPreferences:{textCommunication:'ENABLED'},banStatus:{bannedScopes:{}} };
}
function object(value: unknown): value is Record<string,unknown> { return !!value && typeof value==='object' && !Array.isArray(value); }
function bad(status: string, message: string): never { throw new FriendsError(400,status,message); }
function body(request: FastifyRequest): Record<string,unknown> {
  if (!String(request.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw new FriendsError(415,'INVALID_JSON','Content-Type must be application/json');
  if (!object(request.body)) bad('INVALID_JSON','Expected a JSON object');
  return request.body;
}
function conditional(request: FastifyRequest, reply: FastifyReply, result: unknown) {
  const etag='"'+crypto.createHash('sha256').update(JSON.stringify(result)).digest('base64url')+'"';
  reply.header('ETag',etag).header('Cache-Control','private, no-cache').header('Retry-After','30');
  if (String(request.headers['if-none-match']||'').split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag)) return reply.code(304).send();
  return reply.send(result);
}

export async function registerMinecraftServicesRoutes(app: FastifyInstance): Promise<void> {
  app.register(async service => {
    service.decorateRequest('socialActor',null);
    service.decorateRequest('socialToken','');
    service.addHook('onRequest',async (_request,reply)=>{reply.header('Cache-Control','private, no-store').header('Vary','Authorization');});
    service.setErrorHandler((error: any,request,reply)=>{
      const path=request.url.split('?')[0].replace(/^\/(?:api\/yggdrasil\/)?minecraftservices/,'');
      if(error instanceof FriendsError){
        if(error.statusCode===401)reply.header('WWW-Authenticate','Bearer');
        if(error.statusCode===429)reply.header('Retry-After','60');
        return reply.code(error.statusCode).send({path,details:{status:error.status},errorMessage:error.message});
      }
      if(error.statusCode&&[400,413,415,429].includes(error.statusCode))return reply.code(error.statusCode).send({path,details:{status:error.statusCode===429?'TOO_MANY_REQUESTS':'INVALID_JSON'},errorMessage:'Invalid or excessive request'});
      if(error.code==='ER_NO_SUCH_TABLE')return reply.code(503).send({path,details:{status:'SERVICE_UNAVAILABLE'},errorMessage:'Minecraft Services storage is not initialized'});
      request.log.error({err:error},'Minecraft Services request failed');
      return reply.code(500).send({path,errorMessage:'Minecraft Services request failed'});
    });
    const authenticate = async (request: FastifyRequest) => {
      const bearer=/^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization||''));
      const token=bearer&&await verifyAccessToken(bearer[1]);
      if(!token?.selectedProfile)throw new FriendsError(401,'UNAUTHORIZED','A valid selected-profile access token is required');
      if(!token.scopes.includes(SCOPES.SERVER_JOIN))throw new FriendsError(403,'INSUFFICIENT_PRIVILEGES','A game-session token is required');
      const profile=await profileFromUuid(token.selectedProfile);
      if(!profile||profile.player.uid!==token.userId)throw new FriendsError(401,'UNAUTHORIZED','Profile is no longer available');
      (request as SocialRequest).socialActor=profile;(request as SocialRequest).socialToken=token.jti;
    };
    const options={preHandler:authenticate,bodyLimit:4096};
    for(const prefix of ['/minecraftservices','/api/yggdrasil/minecraftservices']){
      service.get(prefix+'/privileges',options,async()=>({privileges}));
      service.get(prefix+'/privacy/blocklist',options,async()=>({blockedProfiles:[]}));
      service.get(prefix+'/player/attributes',options,async request=>attributes(await socialPreferences((request as SocialRequest).socialActor)));
      service.post(prefix+'/player/attributes',options,async request=>{
        const data=body(request),changes:{friends?:boolean;acceptInvites?:boolean;profanityFilter?:boolean}={};
        if(data.friendsPreferences!=null){
          if(!object(data.friendsPreferences))bad('INVALID_JSON','Invalid friendsPreferences');
          for(const key of ['friends','acceptInvites'] as const){
            const value=data.friendsPreferences[key];
            if(value===undefined)continue;
            if(value!=='ENABLED'&&value!=='DISABLED')bad('INVALID_JSON','Invalid friend preference');
            changes[key]=value==='ENABLED';
          }
        }
        if(data.profanityFilterPreferences!=null){
          if(!object(data.profanityFilterPreferences)||typeof data.profanityFilterPreferences.profanityFilterOn!=='boolean')bad('INVALID_JSON','Invalid profanity filter preference');
          changes.profanityFilter=data.profanityFilterPreferences.profanityFilterOn;
        }
        return attributes(await updateSocialPreferences((request as SocialRequest).socialActor,changes));
      });
      service.get(prefix+'/friends',options,async(request,reply)=>conditional(request,reply,await friendsList((request as SocialRequest).socialActor)));
      service.put(prefix+'/friends',{...options,config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(request,reply)=>{
        const data=body(request);
        if(data.updateType===undefined)bad('CONSTRAINT_VIOLATION','updateType is required');
        if(data.updateType!=='ADD'&&data.updateType!=='REMOVE')bad('INVALID_JSON','Unknown updateType');
        if(data.profileId===undefined&&data.name===undefined)bad('CONSTRAINT_VIOLATION','name or profileId is required');
        if(data.profileId!==undefined&&typeof data.profileId!=='string')bad('INVALID_JSON','Invalid profileId');
        if(data.name!==undefined&&(typeof data.name!=='string'||!data.name.length||data.name.length>100))bad('INVALID_JSON','Invalid name');
        const actor=(request as SocialRequest).socialActor;
        const target=await friendTarget({name:data.name as string|undefined,profileId:data.profileId as string|undefined});
        await updateFriend(actor,target,data.updateType);
        // Mutations always return the new list; conditional 304 applies only to reads/presence.
        return friendsList(actor);
      });
      service.post(prefix+'/presence',options,async(request,reply)=>{
        const data=body(request);
        if(!PRESENCE_STATUSES.includes(data.status as PresenceStatus))bad(data.status===undefined?'CONSTRAINT_VIOLATION':'INVALID_JSON','Invalid presence status');
        const actor=request as SocialRequest;
        return conditional(request,reply,await presence(actor.socialActor,actor.socialToken,data.status as PresenceStatus));
      });
    }
  });
}
