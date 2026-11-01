import {findUserByEmail} from '../src/services/user.js';
import {exec,pool} from '../src/db.js';
const at=process.argv.indexOf('--email'),email=at<0?'':String(process.argv[at+1]||'').trim().toLowerCase();
try{
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Usage: npm run admin:promote -- --email you@example.com --apply. Register your account in the browser first.');
  const user=await findUserByEmail(email);if(!user)throw new Error('Account not found. Register the intended account first.');
  if(!process.argv.includes('--apply'))console.log(`Account UID ${user.uid} found. Add --apply to promote this existing account to administrator.`);
  else{await exec('UPDATE users SET permission=2 WHERE uid=?',[user.uid]);console.log(`Account UID ${user.uid} is now an administrator.`);}
}finally{await pool.end();}
