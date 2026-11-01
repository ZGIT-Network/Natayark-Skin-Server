import fs from 'node:fs/promises';
import {parse} from 'dotenv';
import path from 'node:path';
const reference=process.argv[2]||process.env.LEGACY_DIR;
if(!reference)throw new Error('Pass the reference installation directory or set LEGACY_DIR. Existing configuration was not changed.');
const target=await fs.readFile('.env','utf8'),source=await fs.readFile(path.join(reference,'.env'),'utf8');
const old=parse(source),current=parse(target);
if(old.MAIL_MAILER&&old.MAIL_MAILER!=='smtp')throw new Error('Legacy mailer is not SMTP; no configuration imported.');
const additions=[];
for(const key of ['MAIL_HOST','MAIL_PORT','MAIL_USERNAME','MAIL_PASSWORD','MAIL_FROM_ADDRESS','MAIL_FROM_NAME']){
 if(current[key]||!old[key])continue;
 const raw=source.split(/\r?\n/).find(line=>line.startsWith(key+'='));
 if(!raw||parse(raw)[key]!==old[key])throw new Error('Review multiline or expanded mail configuration before import.');
 additions.push(raw);
}
if(!Object.hasOwn(current,'MAIL_SECURE')&&old.MAIL_HOST)additions.push('MAIL_SECURE='+(old.MAIL_ENCRYPTION==='ssl'||old.MAIL_PORT==='465'?'true':'false'));
if(additions.length){
 await fs.mkdir('artifacts',{recursive:true});
 const backup='artifacts/mail-config-before-'+Date.now()+'.env';await fs.writeFile(backup,target,{mode:0o600});
 const next=target.trimEnd()+'\n\n# Preserved SMTP settings from the legacy site; no test mail is sent by this import.\n'+additions.join('\n')+'\n';
 const parsed=parse(next);for(const line of additions){const [key]=line.split('=');if(key!=='MAIL_SECURE'&&parsed[key]!==old[key])throw new Error('Mail configuration roundtrip mismatch');}
 await fs.writeFile('.env',next);console.log('Imported missing legacy SMTP configuration. Credentials were not printed and no mail was sent.');
}else console.log('No missing legacy SMTP settings.');
