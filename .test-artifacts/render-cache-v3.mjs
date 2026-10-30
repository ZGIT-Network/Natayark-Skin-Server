import fs from 'node:fs';
import path from 'node:path';
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
for(const file of [...walk('src/views').filter(f=>f.endsWith('.ejs')),'public/js/skinview-entry.js']){
  let source=fs.readFileSync(file,'utf8').replaceAll('?v=2&','?v=4&').replaceAll('?v=3&','?v=4&').replaceAll('/preview/default?png','/preview/default?v=4&png');
  source=source.replaceAll('%>?size=64','%>?v=3&size=64');
  fs.writeFileSync(file,source);
}
