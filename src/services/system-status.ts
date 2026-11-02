import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {config} from '../config.js';
import {queryOne} from '../db.js';
import {APP_VERSION} from '../version.js';
import {siteSummary} from './site-data.js';
import {loadProviders} from './oauth-client.js';
import {mojangConfiguration} from './mojang.js';

export async function systemStatus(fastifyVersion: string) {
  const started=performance.now();
  const database=await queryOne<{version:string;name:string;charset:string;collation:string;maxConnections:number}>(
    'SELECT VERSION() version,DATABASE() name,@@character_set_database charset,@@collation_database collation,@@max_connections maxConnections');
  const latency=Number((performance.now()-started).toFixed(2));
  const prefix=config.db.tablePrefix;
  const [tables,summary,providers,microsoft]=await Promise.all([
    queryOne<{count:number;bytes:number}>("SELECT COUNT(*) count,COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND LEFT(TABLE_NAME,?)=?",[prefix.length,prefix]),
    siteSummary(),loadProviders(),mojangConfiguration(),
  ]);
  let textureWritable=false,textureState='permissions',disk:{available:number;total:number}|null=null;
  try {const stat=await fs.stat(config.textureDir);if(stat.isDirectory()){await fs.access(config.textureDir,constants.R_OK|constants.W_OK);textureWritable=true;textureState='healthy';}else textureState='not-directory';}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')textureState='directory-missing';}
  let diskPath=config.textureDir;
  for(;;){
    try{const stat=await fs.statfs(diskPath);disk={available:stat.bavail*stat.bsize,total:stat.blocks*stat.bsize};break;}
    catch(error){const parent=path.dirname(diskPath);if((error as NodeJS.ErrnoException).code!=='ENOENT'||parent===diskPath)break;diskPath=parent;}
  }
  const memory=process.memoryUsage(),cpu=process.cpuUsage();
  return {
    version:APP_VERSION,node:process.version,fastify:fastifyVersion,v8:process.versions.v8,
    platform:`${os.type()} ${os.release()} · ${os.arch()}`,cpuModel:os.cpus()[0]?.model??os.arch(),cpuCores:os.availableParallelism(),
    mode:process.env.NODE_ENV||'development',pid:process.pid,uptime:Math.floor(process.uptime()),startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),timezone:config.tz,
    memory:{rss:memory.rss,heapUsed:memory.heapUsed,heapTotal:memory.heapTotal,external:memory.external,hostFree:os.freemem(),hostTotal:os.totalmem()},
    cpu:{userSeconds:Number((cpu.user/1e6).toFixed(2)),systemSeconds:Number((cpu.system/1e6).toFixed(2))},eventLoopPercent:Number((performance.eventLoopUtilization().utilization*100).toFixed(1)),
    database:{...database,latency,tables:Number(tables?.count??0),bytes:Number(tables?.bytes??0),prefix},
    disk,textureWritable,textureState,textureDir:config.textureDir,summary,providerCount:providers.length,microsoftConfigured:microsoft.configured,
    mailConfigured:!!(config.mail.host&&config.mail.fromAddress),sampledAt:new Date().toISOString(),
  };
}
