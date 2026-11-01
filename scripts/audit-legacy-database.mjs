import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import {parse} from 'dotenv';
import path from 'node:path';
const baseline=JSON.parse(await fs.readFile('artifacts/original-checksums.json','utf8'));
const db=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE,dateStrings:true});
const quote=name=>{if(!/^[A-Za-z0-9_]+$/.test(name))throw new Error('Invalid table name');return '`'+name+'`';};
try {
 const [metadata]=await db.query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
 const [indexes]=await db.query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX');
 const tables=[];
 for(const name of Object.keys(baseline)){
  const [[count]]=await db.query('SELECT COUNT(*) AS total FROM '+quote(name));
  const [[checksum]]=await db.query('CHECKSUM TABLE '+quote(name));
  const columns=metadata.filter(row=>row.TABLE_NAME===name).map(({TABLE_NAME,...row})=>row);
  const target=metadata.filter(row=>row.TABLE_NAME===(process.env.DB_TABLE_PREFIX||'')+name).map(({TABLE_NAME,...row})=>row);
  const differences=columns.flatMap(column=>{const copy=target.find(item=>item.COLUMN_NAME===column.COLUMN_NAME);return JSON.stringify(column)===JSON.stringify(copy)?[]:[{column:column.COLUMN_NAME,original:column,copy}];});
  tables.push({name,rows:Number(count.total),checksumUnchanged:checksum.Checksum===baseline[name],columns,indexes:indexes.filter(row=>row.TABLE_NAME===name).map(({TABLE_NAME,...row})=>row),copyDifferences:differences});
 }
 const [[users]]=await db.query("SELECT COUNT(*) AS total,SUM(password='' OR password IS NULL) AS withoutPassword,SUM(email='' OR email IS NULL) AS withoutEmail,SUM(verified=1) AS verified FROM users");
 const [passwords]=await db.query("SELECT password FROM users WHERE password<>'' AND password IS NOT NULL");
 const method=(process.env.PWD_METHOD||'BCRYPT').toUpperCase(),digestLength={MD5:32,SHA256:64,SHA512:128,SALTED2MD5:32,SALTED2SHA256:64,SALTED2SHA512:128}[method];
 const passwordStorage={bcrypt:0,argon:0,legacyDigest:0,unsupported:0};
 for(const {password}of passwords){if(/^\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}$/.test(password))passwordStorage.bcrypt++;else if(/^\$argon2(?:i|id|d)\$/.test(password))passwordStorage.argon++;else if(digestLength&&new RegExp('^[a-f0-9]{'+digestLength+'}$','i').test(password))passwordStorage.legacyDigest++;else passwordStorage.unsupported++;}
 const [[duplicates]]=await db.query("SELECT COUNT(*) AS groups FROM (SELECT LOWER(email) FROM users WHERE email<>'' GROUP BY LOWER(email) HAVING COUNT(*)>1) d");
 const [[plugins]]=await db.query("SELECT option_value FROM options WHERE option_name='plugins_enabled' LIMIT 1");
 let enabled;try{const value=JSON.parse(plugins?.option_value||'{}');enabled=Array.isArray(value)?value:Object.keys(value);}catch{enabled=[];}
 const identityCandidates=metadata.filter(row=>Object.hasOwn(baseline,row.TABLE_NAME)&&/provider|subject|social|external|identity|openid/i.test(row.COLUMN_NAME)).map(row=>({table:row.TABLE_NAME,column:row.COLUMN_NAME}));
 let legacyEnv={};const reference=process.argv[2]||process.env.LEGACY_DIR;try{if(reference)legacyEnv=parse(await fs.readFile(path.join(reference,'.env')));}catch{/* The report will explicitly mark absent reference configuration. */}
 const credentialComparison=Object.fromEntries(['PWD_METHOD','SALT','NYKID_KEY','NYKID_SECRET','LIVE_KEY','LIVE_SECRET','MAIL_HOST','MAIL_PORT','MAIL_USERNAME','MAIL_PASSWORD','MAIL_FROM_ADDRESS','MAIL_FROM_NAME','ALICDN_SITE_BASE_URL','ALICDN_ACCESSKEY_ID','ALICDN_ACCESSKEY_SECRET'].map(key=>[key,{legacyPresent:!!legacyEnv[key],currentPresent:!!process.env[key],matches:(legacyEnv[key]||'')===(process.env[key]||'')}]));
 const report={checkedAt:new Date().toISOString(),sourceDatabase:process.env.DB_DATABASE,copyPrefix:process.env.DB_TABLE_PREFIX,tables,users,passwordStorage,duplicateEmailGroups:Number(duplicates.groups),enabledPlugins:enabled,identityCandidates,credentialComparison};
 await fs.writeFile('artifacts/legacy-database-audit.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({tables:tables.length,unchanged:tables.filter(table=>table.checksumUnchanged).length,users,passwordStorage,duplicateEmailGroups:report.duplicateEmailGroups,enabledPlugins:enabled,identityCandidates,credentialComparison,copyDifferences:tables.filter(table=>table.copyDifferences.length).map(table=>({table:table.name,columns:table.copyDifferences.map(column=>({name:column.column,from:column.original.COLUMN_TYPE,to:column.copy?.COLUMN_TYPE}))}))},null,2));
}finally{await db.end();}
