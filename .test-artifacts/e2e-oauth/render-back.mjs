import fs from 'node:fs';
import { renderSkin3d, pngToBuffer } from '../../src/services/render.js';
const texDir = 'storage/textures';
let skin64 = null;
for (const f of fs.readdirSync(texDir).slice(0, 40)) {
  const data = fs.readFileSync(`${texDir}/${f}`);
  if (data.length < 24) continue;
  const w = data.readUInt32BE(16), h = data.readUInt32BE(20);
  if (w === 64 && h === 64) { skin64 = data; break; }
}
fs.writeFileSync('.test-artifacts/render-out/back-only.png', pngToBuffer(renderSkin3d(skin64, 12, false, 135, -25, false)));
fs.writeFileSync('.test-artifacts/render-out/front-only.png', pngToBuffer(renderSkin3d(skin64, 12, false, -45, -25, false)));
console.log('done');
