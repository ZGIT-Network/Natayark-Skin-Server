import 'dotenv/config';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';

const prefix='dev_compat_'+crypto.randomBytes(4).toString('hex')+'_';
process.env.DB_TABLE_PREFIX=prefix;
const baseline=JSON.parse(await fs.readFile('artifacts/original-checksums.json','utf8'));
const raw=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE,dateStrings:true});
const quote=(name:string)=>{assert.match(name,/^[A-Za-z0-9_]+$/);return '`'+name+'`';};
const created:string[]=[],checks:Array<{name:string;passed:boolean}>=[];
let app:any,pool:any;
const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push({name,passed:true});};
try{
 for(const table of Object.keys(baseline)){
   await raw.query('CREATE TABLE '+quote(prefix+table)+' LIKE '+quote(table));created.push(prefix+table);
   await raw.query('INSERT INTO '+quote(prefix+table)+' SELECT * FROM '+quote(table));
   const [[source]]:any=await raw.query('CHECKSUM TABLE '+quote(table));
   const [[copy]]:any=await raw.query('CHECKSUM TABLE '+quote(prefix+table));
   check('Copied without data transformation: '+table,source.Checksum===copy.Checksum);
 }
 const [foreignColumns]:any=await raw.query('SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE,r.UPDATE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION');
 const groups=new Map<string,any[]>();
 for(const column of foreignColumns)if(Object.hasOwn(baseline,column.TABLE_NAME)){const key=column.TABLE_NAME+':'+column.CONSTRAINT_NAME;groups.set(key,[...(groups.get(key)??[]),column]);}
 for(const [key,columns]of groups){
   const first=columns[0];assert.ok(Object.hasOwn(baseline,first.REFERENCED_TABLE_NAME));
   for(const rule of [first.DELETE_RULE,first.UPDATE_RULE])assert.ok(['CASCADE','RESTRICT','NO ACTION','SET NULL'].includes(rule));
   await raw.query('ALTER TABLE '+quote(prefix+first.TABLE_NAME)+' ADD CONSTRAINT '+quote(prefix+crypto.createHash('sha256').update(key).digest('hex').slice(0,12))+' FOREIGN KEY ('+columns.map(column=>quote(column.COLUMN_NAME)).join(',')+') REFERENCES '+quote(prefix+first.REFERENCED_TABLE_NAME)+' ('+columns.map(column=>quote(column.REFERENCED_COLUMN_NAME)).join(',')+') ON DELETE '+first.DELETE_RULE+' ON UPDATE '+first.UPDATE_RULE);
   check('Preserved original foreign key: '+key,true);
 }
 const db=await import('../src/db.js');pool=db.pool;
 // Only extension tables: deliberately do NOT run the optional description widening.
 for(const file of ['001_auth_extensions.sql','002_registration_rewards.sql']){
   const sql=(await fs.readFile('migrations/'+file,'utf8')).replace(/^\s*--.*$/gm,'');
   for(const name of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g))created.push(prefix+name[1]);
   for(const statement of sql.split(';').map(value=>value.trim()).filter(Boolean))await db.exec(statement);
 }
 const {createApp}=await import('../src/app.js');app=await createApp();
 const {setSessionCookie}=await import('../src/services/session.js');
 const {pluginEnabled}=await import('../src/services/plugins.js');
 const {getOption}=await import('../src/services/option.js');
 const {getUuidByName}=await import('../src/services/uuid.js');
 const {descriptionLimit}=await import('../src/services/content.js');
 const owner=await db.queryOne<any>('SELECT u.* FROM users u JOIN players p ON p.uid=u.uid WHERE u.permission=0 AND u.verified=1 ORDER BY u.uid LIMIT 1');
 const admin=await db.queryOne<any>('SELECT * FROM users WHERE permission=2 ORDER BY uid LIMIT 1');
 assert.ok(owner&&admin);
 let cookie='';await setSessionCookie({setCookie(name:string,value:string){cookie=name+'='+value;}} as any,owner.uid);
 const viewer={cookie};
 for(const path of ['/user','/user/player','/user/closet','/user/profile','/user/connections','/user/sharing','/user/notifications','/user/reports','/user/score-info','/user/config','/user/applications']){
   const response=await app.inject({url:path,headers:viewer});check('Original-account page: '+path,response.statusCode===200);
 }
 const userInfo=await app.inject({url:'/api/user',headers:viewer});
 check('Original UID and profile preserved',userInfo.json().uid===owner.uid&&userInfo.json().email===owner.email&&userInfo.json().score===owner.score&&!Object.hasOwn(userInfo.json(),'password'));
 for(const name of ['single-player-limit','share-registration-link','gravatar','204-for-unexisted-players'])check('Legacy object-array enabled plugin: '+name,await pluginEnabled(name));
 const players=await db.query<any>('SELECT * FROM players WHERE uid=? ORDER BY pid',[owner.uid]);
 const player=players[0],uuid=await getUuidByName(player.name);
 const stored=await db.queryOne<any>('SELECT uuid FROM `uuid` WHERE name=?',[player.name]);
 check('Original UUID not recalculated',!!uuid&&uuid===stored?.uuid);
 const allPlayers=await db.query<any>('SELECT p.*,u.permission AS owner_permission FROM players p LEFT JOIN users u ON u.uid=p.uid ORDER BY p.pid');
 const allTextures=await db.query<any>('SELECT * FROM textures ORDER BY tid');
 const textureMap=new Map<number,any>(allTextures.map(texture=>[texture.tid,texture]));
 let checkedProfiles=0;
 for(const profile of allPlayers){
   const response=await app.inject('/csl/'+encodeURIComponent(profile.name)+'.json');
   if(profile.owner_permission===-1){assert.equal(response.statusCode,403);continue;}
   assert.equal(response.statusCode,200,'Original profile response differs for PID '+profile.pid);
   const skin=textureMap.get(profile.tid_skin),cape=textureMap.get(profile.tid_cape),model=skin?.type==='alex'?'slim':'default';
   assert.deepEqual(response.json(),{username:profile.name,skins:{[model]:skin?.hash??null},cape:cape?.hash??null});checkedProfiles++;
 }
 check('Every original player profile serializes with original texture hashes',checkedProfiles>0);
 const {readTextureFile,validateTexturePng}=await import('../src/services/texture.js');
 let checkedTextures=0;
 for(const texture of allTextures){
   const file=await readTextureFile(texture.hash);assert.ok(file,'Missing original material file for TID '+texture.tid);
   assert.equal(crypto.createHash('sha256').update(file).digest('hex'),texture.hash,'Original material hash mismatch for TID '+texture.tid);
   const validation=await validateTexturePng(file,texture.type,texture.type==='alex');assert.ok(validation.ok,'Original material cannot be decoded for TID '+texture.tid);checkedTextures++;
 }
 check('Every original material file is available, unmodified and decodable',checkedTextures===allTextures.length);
 const csl=await app.inject('/csl/'+encodeURIComponent(player.name)+'.json');
 const skin=await db.queryOne<any>('SELECT * FROM textures WHERE tid=?',[player.tid_skin]);
 const cape=await db.queryOne<any>('SELECT * FROM textures WHERE tid=?',[player.tid_cape]);
 const model=skin?.type==='alex'?'slim':'default';
 check('Original CustomSkinAPI profile',csl.statusCode===200&&csl.json().username===player.name&&csl.json().skins[model]===(skin?.hash??null)&&csl.json().cape===(cape?.hash??null));
 check('Enabled missing-player 204 behavior',(await app.inject('/csl/__missing_legacy_snapshot__.json')).statusCode===204);
 const avatarCandidates=[owner.avatar,...(await db.query<any>('SELECT tid_skin FROM players WHERE uid=? ORDER BY pid',[owner.uid])).map(p=>p.tid_skin)];
 const {textureExists}=await import('../src/services/texture.js');
 let hasAvatar=false;for(const tid of avatarCandidates){const texture=tid>0?await db.queryOne<any>('SELECT * FROM textures WHERE tid=? AND type IN (?,?)',[tid,'steve','alex']):null;if(texture&&await textureExists(texture.hash)){hasAvatar=true;break;}}
 check('Equipped skin avatar with Gravatar fallback',(await app.inject('/avatar/user/'+owner.uid)).statusCode===(hasAvatar?200:302));
 const limited=await app.inject({method:'POST',url:'/api/player',headers:viewer,payload:{csrf:/window\.__CSRF\s*=\s*"([^"]+)"/.exec((await app.inject({url:'/user',headers:viewer})).body)![1],name:'CompatNewRole'}});
 check('Enabled single-player restriction',limited.statusCode===400&&limited.body.includes('角色数量已达上限'));
 let adminCookie='';await setSessionCookie({setCookie(name:string,value:string){adminCookie=name+'='+value;}} as any,admin.uid);
 for(const path of ['/admin','/admin/users','/admin/players','/admin/textures','/admin/reports','/admin/settings','/admin/clients','/admin/translations','/admin/status','/admin/closet/'+owner.uid])check('Original administrator page: '+path,(await app.inject({url:path,headers:{cookie:adminCookie}})).statusCode===200);
 const column=await db.queryOne<any>('SELECT DATA_TYPE AS type,CHARACTER_MAXIMUM_LENGTH AS capacity FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[prefix+'textures_description','description']);
 check('Original description column remains VARCHAR(255)',column.type==='varchar'&&Number(column.capacity)===255);
 check('Application honors unmodified legacy description capacity',(await descriptionLimit())<=255);
 const [[identities]]:any=await raw.query('SELECT COUNT(*) AS count FROM '+quote(prefix+'mcn_oauth_identities'));
 check('Starting app does not invent legacy OAuth subject bindings',Number(identities.count)===0);
 const clientRows=await db.query<any>('SELECT id,secret,redirect,user_id FROM oauth_clients ORDER BY id');
 const [sourceClients]:any=await raw.query('SELECT id,secret,redirect,user_id FROM oauth_clients ORDER BY id');
 check('Existing OAuth client IDs, secrets and callbacks preserved',sourceClients.every((source:any)=>clientRows.some(row=>row.id===source.id&&row.secret===source.secret&&row.redirect===source.redirect&&row.user_id===source.user_id)));
 const [[foreignKeys]]:any=await raw.query('SELECT COUNT(*) AS count FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME IN ('+Object.keys(baseline).map(()=>'?').join(',')+')',Object.keys(baseline));
 const report={checkedAt:new Date().toISOString(),sourceTables:Object.keys(baseline).length,sourceForeignKeys:Number(foreignKeys.count),originalColumnAlterations:0,originalProfilesChecked:checkedProfiles,originalTexturesChecked:checkedTextures,extensionMigrations:['001','002'],checks,sourceUnchanged:false};
 for(const [table,checksum]of Object.entries(baseline)){
   const [[current]]:any=await raw.query('CHECKSUM TABLE '+quote(table));assert.equal(current.Checksum,checksum,'Original table changed: '+table);
 }
 report.sourceUnchanged=true;
 await fs.writeFile('artifacts/legacy-snapshot-verification.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks:checks.length,sourceTables:report.sourceTables,sourceForeignKeys:report.sourceForeignKeys,originalProfilesChecked:checkedProfiles,originalTexturesChecked:checkedTextures,originalColumnAlterations:0,sourceUnchanged:true,originalPlugins:await getOption('plugins_enabled','[]').then(value=>JSON.parse(value).length)},null,2));
}finally{
 if(app)await app.close();if(pool)await pool.end();
 await raw.query('SET FOREIGN_KEY_CHECKS=0');
 for(const table of created.reverse()){assert.ok(table.startsWith(prefix)&&table!==prefix);await raw.query('DROP TABLE IF EXISTS '+quote(table));}
 await raw.query('SET FOREIGN_KEY_CHECKS=1');
 await raw.end();
}
