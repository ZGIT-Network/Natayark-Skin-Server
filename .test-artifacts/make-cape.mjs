import fs from 'node:fs';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
const png = new PNG({width:64,height:32});
crypto.randomFillSync(png.data);
for (let i=3;i<png.data.length;i+=4) png.data[i]=255;
fs.writeFileSync('.test-artifacts/review-cape.png',PNG.sync.write(png));
