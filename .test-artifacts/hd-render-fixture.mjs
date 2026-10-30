import fs from 'node:fs';
import {PNG} from 'pngjs';
const source=PNG.sync.read(fs.readFileSync('public/app/default-skin.png'));
for(let y=36;y<48;y++)for(let x=20;x<28;x++)source.data.set([52,177,122,255],(y*64+x)*4);
const output=new PNG({width:128,height:128});
for(let y=0;y<128;y++)for(let x=0;x<128;x++)source.data.copy(output.data,(y*128+x)*4,(Math.floor(y/2)*64+Math.floor(x/2))*4,(Math.floor(y/2)*64+Math.floor(x/2))*4+4);
fs.writeFileSync('tests/fixtures/hd-layered-skin.png',PNG.sync.write(output));
