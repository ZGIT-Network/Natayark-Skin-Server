import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { renderSkin3d, render2dAvatar, renderSkin } from '../src/services/render.js';

function headFixture(): Buffer {
  const png = new PNG({ width:64,height:64 });
  const face=(x:number,y:number,color:number[])=>{
    for(let yy=y;yy<y+8;yy++) for(let xx=x;xx<x+8;xx++) {
      const at=(yy*64+xx)*4; for(let channel=0;channel<3;channel++) png.data[at+channel]=color[channel]; png.data[at+3]=255;
    }
  };
  face(8,8,[255,0,0]); face(24,8,[0,0,255]);
  face(0,8,[0,255,0]); face(16,8,[255,255,0]);
  face(8,0,[255,255,255]); face(16,0,[0,255,255]);
  return PNG.sync.write(png);
}
test('isometric head projects the front, left and top faces onto the output',()=>{
  const image=renderSkin3d(headFixture(),8,true,-45,-25,false).png;
  const counts=new Map<string,number>();
  for(let i=0;i<image.data.length;i+=4) if(image.data[i+3]===255) {
    const color=[image.data[i],image.data[i+1],image.data[i+2]].join(','); counts.set(color,(counts.get(color)||0)+1);
  }
  for(const color of ['255,0,0','255,255,0','255,255,255']) assert.ok((counts.get(color)||0)>100,`Missing projected face ${color}`);
  assert.ok(image.width>64 && image.height>64);
});
test('unrotated 2D avatar remains a front-facing head',()=>{
  const image=render2dAvatar(headFixture(),8).png;
  let red=0;
  for(let i=0;i<image.data.length;i+=4) if(image.data[i]===255&&image.data[i+1]===0&&image.data[i+2]===0&&image.data[i+3]===255) red++;
  assert.ok(red>1000);
});

test('full-body preview matches an independently generated legacy PHP reference', () => {
  const source = fs.readFileSync(new URL('../public/app/default-skin.png', import.meta.url));
  const expected = PNG.sync.read(fs.readFileSync(new URL('./fixtures/legacy-default-preview.png', import.meta.url)));
  const actual = renderSkin(source).png;
  assert.equal(actual.width, expected.width);
  assert.equal(actual.height, expected.height);
  let error = 0, intersection = 0, union = 0;
  for (let i = 0; i < expected.data.length; i += 4) {
    const a = expected.data[i + 3] / 255, b = actual.data[i + 3] / 255;
    if (a > .5 || b > .5) union++;
    if (a > .5 && b > .5) intersection++;
    for (let c = 0; c < 3; c++) error += Math.abs(expected.data[i + c] * a + 255 * (1 - a) - actual.data[i + c] * b - 255 * (1 - b));
  }
  // GD and the JS rasterizer antialias polygon boundaries differently.
  assert.ok(error / (expected.width * expected.height * 3) < 2);
  assert.ok(intersection / union > .99, 'Body faces must remain joined and inside the canvas');
});

test('slim arms touch the torso and use the same front UV regions as skinview3d', () => {
  const png = new PNG({width:64,height:64});
  const fill = (x:number,y:number,width:number,height:number,color:number[]) => {
    for(let yy=y;yy<y+height;yy++) for(let xx=x;xx<x+width;xx++) {
      const offset=(yy*64+xx)*4;
      png.data.set([...color,255],offset);
    }
  };
  fill(20,20,8,12,[128,128,128]);
  fill(44,20,3,12,[255,0,0]);
  fill(36,52,3,12,[0,0,255]);
  const image=renderSkin3d(PNG.sync.write(png),4,false,0,0,true).png;
  const y=40;
  const opaque=[];
  for(let x=0;x<image.width;x++) if(image.data[(y*image.width+x)*4+3]>128) opaque.push(x);
  assert.ok(opaque.length>40);
  assert.equal(opaque.at(-1)!-opaque[0]+1,opaque.length,'No gap may appear between an arm and the torso');
  const red=opaque.filter(x=>image.data[(y*image.width+x)*4]===255).length;
  const blue=opaque.filter(x=>image.data[(y*image.width+x)*4+2]===255).length;
  assert.equal(red,12);
  assert.equal(blue,12);
});

test('HD skin overlays use scaled UV coordinates',()=>{
  const image=renderSkin(fs.readFileSync(new URL('./fixtures/hd-layered-skin.png',import.meta.url))).png;
  let overlayPixels=0;
  for(let i=0;i<image.data.length;i+=4)if(image.data[i]===52&&image.data[i+1]===177&&image.data[i+2]===122&&image.data[i+3]===255)overlayPixels++;
  assert.ok(overlayPixels>1000,'The green outer shirt must cover the HD torso, not the head');
});
