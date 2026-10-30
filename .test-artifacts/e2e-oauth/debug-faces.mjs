import fs from 'node:fs';
import { PNG } from 'pngjs';

// Minimal inline reimplementation to isolate which faces get drawn where.
const src = fs.readFileSync('storage/textures/' + fs.readdirSync('storage/textures').find(f => { const d = fs.readFileSync('storage/textures/'+f); return d.readUInt32BE(16) === 64 && d.readUInt32BE(20) === 64; }));
const skin = PNG.sync.read(src);
const r = 1, ca = Math.cos(-25*Math.PI/180), sa = Math.sin(-25*Math.PI/180), cw = Math.cos(135*Math.PI/180), sw = Math.sin(135*Math.PI/180);
const proj = (x,y,z) => [x*cw + z*sw, x*sa*sw + y*ca - z*sa*cw, -x*ca*sw + y*sa + z*ca*cw];
// head front face texel (0,0) corners:
const f00 = [[0,0,6],[1,0,6],[1,1,6],[0,1,6]].map(p => proj(...p));
// head right face texel (z=5..6, y=0..1) corners:
const s00 = [[0,0,5],[0,0,6],[0,1,6],[0,1,5]].map(p => proj(...p));
// head back face texel (0,0) corners:
const b00 = [[0,0,-2],[1,0,-2],[1,1,-2],[0,1,-2]].map(p => proj(...p));
console.log('front(0,0):', f00.map(p=>p.slice(0,2).map(v=>v.toFixed(2)).join(',')));
console.log('right(0,0):', s00.map(p=>p.slice(0,2).map(v=>v.toFixed(2)).join(',')));
console.log('back(0,0):', b00.map(p=>p.slice(0,2).map(v=>v.toFixed(2)).join(',')));
