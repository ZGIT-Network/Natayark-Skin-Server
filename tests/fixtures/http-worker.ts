import {createApp} from '../../src/app.js';
import {config} from '../../src/config.js';
import {pool} from '../../src/db.js';
if(!process.send||!config.db.tablePrefix.startsWith('dev_'))throw new Error('Only run as an isolated integration child');
config.mail.host='';config.mail.fromAddress='';
const app=await createApp();await app.listen({port:0,host:'127.0.0.1'});
process.send({port:(app.server.address() as any).port});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();await pool.end();process.exit(0);}
process.on('message',message=>{if(message==='stop')void stop();});process.on('disconnect',()=>void stop());
