import fs from 'node:fs';
import path from 'node:path';
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
for(const file of walk('src/views').filter(f=>f.endsWith('.ejs'))){
  let source=fs.readFileSync(file,'utf8');
  source=source.replaceAll('?model=', '?v=2&model=').replaceAll('?png', '?v=2&png');
  fs.writeFileSync(file,source);
}
