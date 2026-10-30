import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { exec, pool } from '../src/db.js';
import { registerUser } from '../src/services/user.js';
import { createClient } from '../src/services/oidc.js';
import { setSessionCookie } from '../src/services/session.js';

test('independent OIDC client: discovery, signed code flow, consent, refresh and Minecraft join over HTTP', {skip:!config.db.tablePrefix.startsWith('dev_'),timeout:30000}, async () => {
  const app=await createApp(), originalIssuer=config.oidcIssuer;
  const suffix=crypto.randomBytes(4).toString('hex'), name='Oidc'+suffix;
  let uid:number|undefined, clientId:number|undefined;
  try {
    const base=await app.listen({host:'127.0.0.1',port:0});
    config.oidcIssuer=base;
    const user=await registerUser({email:name+'@example.test',nickname:name,player_name:name,password:'HTTP-test-password',verified:true});
    assert.ok(user.ok);uid=user.user.uid;
    clientId=await createClient({name:'Independent HTTP test',secret:null,redirects:['http://127.0.0.1:8877/callback'],ownerId:uid});
    const client=await oidc.discovery(new URL(base),String(clientId),{token_endpoint_auth_method:'none'},oidc.None(),{execute:[oidc.allowInsecureRequests]});
    for(const key of ['authorization_endpoint','token_endpoint','userinfo_endpoint','jwks_uri'] as const)assert.equal(new URL(client.serverMetadata()[key]!).origin,base,'All Connect endpoints must be served by this app');
    oidc.enableNonRepudiationChecks(client);
    const verifier=oidc.randomPKCECodeVerifier(), state=oidc.randomState(), nonce=oidc.randomNonce();
    const authorization=oidc.buildAuthorizationUrl(client,{redirect_uri:'http://127.0.0.1:44999/callback',response_type:'code',scope:'openid offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join',code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state,nonce});
    // An existing signed-in session is fixture setup; authorization itself is real HTTP.
    const cookies=new Map<string,string>();
    await setSessionCookie({setCookie(key:string,value:string){cookies.set(key,value);}} as any,uid);
    async function browser(url:string|URL, body?:Record<string,string>) {
      const response=await fetch(new URL(url,base),{redirect:'manual',method:body?'POST':'GET',headers:{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body):undefined});
      for(const cookie of response.headers.getSetCookie()) {const pair=cookie.split(';')[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
      return response;
    }
    const begin=await browser(authorization);assert.equal(begin.status,302);
    const interaction=begin.headers.get('location')!;
    const consentPage=await browser(interaction);assert.equal(consentPage.status,200);
    const html=await consentPage.text();
    const csrf=/name="csrf" value="([^"]+)"/.exec(html)?.[1];
    const profile=/name="selectedProfile" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf&&profile,'Consent page includes CSRF and a real owned profile');
    const approved=await browser(interaction+'/confirm',{csrf,selectedProfile:profile});assert.equal(approved.status,302);
    const callback=new URL(approved.headers.get('location')!);
    const tokens=await oidc.authorizationCodeGrant(client,callback,{pkceCodeVerifier:verifier,expectedState:state,expectedNonce:nonce});
    assert.ok(tokens.id_token&&tokens.refresh_token);
    const claims=tokens.claims()!;
    assert.equal((claims.selectedProfile as {id:string}).id,profile);
    const info=await oidc.fetchUserInfo(client,tokens.access_token,claims.sub);
    assert.equal((info.selectedProfile as {id:string}).id,profile);
    const refreshed=await oidc.refreshTokenGrant(client,tokens.refresh_token);
    assert.ok(refreshed.refresh_token&&refreshed.refresh_token!==tokens.refresh_token);
    assert.equal((await oidc.fetchUserInfo(client,refreshed.access_token,claims.sub)).sub,claims.sub);
    const serverId='oidc-http-'+suffix;
    const join=await fetch(base+'/api/yggdrasil/sessionserver/session/minecraft/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessToken:refreshed.access_token,selectedProfile:profile,serverId})});
    assert.equal(join.status,204);
    const joined=await fetch(base+'/api/yggdrasil/sessionserver/session/minecraft/hasJoined?'+new URLSearchParams({username:name,serverId}));
    assert.equal(joined.status,200);
    assert.ok((await joined.json() as any).properties[0].signature);
    await oidc.tokenRevocation(client,refreshed.refresh_token);
    await assert.rejects(oidc.fetchUserInfo(client,refreshed.access_token,claims.sub));
  } finally {
    config.oidcIssuer=originalIssuer;
    if(clientId) {
      await exec('DELETE r FROM oauth_refresh_tokens r JOIN oauth_access_tokens a ON a.id=r.access_token_id WHERE a.client_id=?',[clientId]);
      await exec('DELETE FROM oauth_access_tokens WHERE client_id=?',[clientId]);
      for(const table of ['yggc_authorization_codes','yggc_device_codes','yggc_interactions','yggc_grants','yggc_refresh_tokens'])await exec(`DELETE FROM ${table} WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.clientId'))=? OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.params.client_id'))=?`,[String(clientId),String(clientId)]);
      await exec('DELETE FROM oauth_clients WHERE id=?',[clientId]);
    }
    if(uid) {
      await exec('DELETE FROM `uuid` WHERE name=?',[name]);await exec('DELETE FROM players WHERE uid=?',[uid]);
      await exec('DELETE FROM mcn_web_sessions WHERE user_id=?',[uid]);await exec('DELETE FROM ygg_log WHERE user_id=?',[uid]);await exec('DELETE FROM users WHERE uid=?',[uid]);
    }
    await app.close();await pool.end();
  }
});
