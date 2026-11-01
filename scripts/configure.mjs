import fs from 'node:fs/promises';
import crypto from 'node:crypto';
try {
  const example=await fs.readFile(new URL('../.env.example',import.meta.url),'utf8');
  const content=example.replace(/^APP_KEY=.*$/m,'APP_KEY='+crypto.randomBytes(32).toString('hex'));
  await fs.writeFile(new URL('../.env',import.meta.url),content,{flag:'wx',mode:0o600});
  console.log('Created .env with a random APP_KEY. Configure the database before running npm run db:init -- --apply.');
}catch(error){
  if(error.code==='EEXIST')console.log('.env already exists; existing configuration and keys were preserved.');
  else throw error;
}
