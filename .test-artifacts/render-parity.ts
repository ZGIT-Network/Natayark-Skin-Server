import fs from 'node:fs';
import {PNG} from 'pngjs';
import {renderSkin,pngToBuffer} from '../src/services/render.js';
const data=fs.readFileSync(process.argv[2]||'public/app/default-skin.png');
const result=renderSkin(data);
fs.writeFileSync('output/playwright/default-node.png',pngToBuffer(result));
console.log('Node:',result.width,result.height);
const legacy=PNG.sync.read(fs.readFileSync(process.argv[3]||'output/playwright/default-legacy.png'));
console.log('PHP:',legacy.width,legacy.height);
let error=0,intersection=0,union=0;
for(let i=0;i<legacy.data.length;i+=4){
  const a=legacy.data[i+3]/255,b=result.png.data[i+3]/255;
  if(a>.5||b>.5)union++; if(a>.5&&b>.5)intersection++;
  for(let c=0;c<3;c++)error+=Math.abs(legacy.data[i+c]*a+255*(1-a)-result.png.data[i+c]*b-255*(1-b));
}
console.log({meanChannelError:error/(legacy.width*legacy.height*3),silhouetteIoU:intersection/union});
