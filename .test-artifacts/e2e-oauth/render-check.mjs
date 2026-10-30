// Render smoke check: exercises the ported renderer against real textures.
import fs from 'node:fs';
import { render2dAvatar, render3dAvatar, renderSkin, renderCape, pngToBuffer, defaultAvatar, resizeTo } from '../../src/services/render.js';

const texDir = 'storage/textures';
const files = fs.readdirSync(texDir).slice(0, 40).map((f) => `${texDir}/${f}`);
// pick one 64x64 (new) and one 64x32 (old) skin by header size read via pngjs
const { PNG } = await import('pngjs');
let skin64 = null, skin32 = null, cape = null;
for (const f of files) {
  const data = fs.readFileSync(f);
  if (data.length < 24) continue;
  const w = data.readUInt32BE(16), h = data.readUInt32BE(20);
  if (!skin64 && w === 64 && h === 64) skin64 = data;
  if (!skin32 && w === 64 && h === 32) skin32 = data;
  if (!cape && w === 64 && h === 32 && h / w === 0.5) { /* capes are 64x32 too */ }
}
// any 2:1 texture can serve as cape-ish; just render what we have
fs.mkdirSync('.test-artifacts/render-out', { recursive: true });
if (skin64) {
  fs.writeFileSync('.test-artifacts/render-out/skin64-preview.png', pngToBuffer(renderSkin(skin64, 12, false)));
  fs.writeFileSync('.test-artifacts/render-out/skin64-avatar2d.png', pngToBuffer(resizeTo(render2dAvatar(skin64), 100)));
  fs.writeFileSync('.test-artifacts/render-out/skin64-avatar3d.png', pngToBuffer(resizeTo(render3dAvatar(skin64), 100)));
  fs.writeFileSync('.test-artifacts/render-out/skin64-avatar3d-48.png', pngToBuffer(resizeTo(render3dAvatar(skin64), 48)));
}
if (skin32) {
  fs.writeFileSync('.test-artifacts/render-out/skin32-preview.png', pngToBuffer(renderSkin(skin32, 12, false)));
  fs.writeFileSync('.test-artifacts/render-out/skin32-avatar3d.png', pngToBuffer(resizeTo(render3dAvatar(skin32), 100)));
}
fs.writeFileSync('.test-artifacts/render-out/default-3d.png', pngToBuffer(defaultAvatar(100, '3d')));
console.log(JSON.stringify({ skin64: !!skin64, skin32: !!skin32 }));
