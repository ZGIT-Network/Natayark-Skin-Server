import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { readTextureFile, textureExists } from './texture.js';
import { ROOT_DIR } from '../config.js';

/**
 * Server-side texture rendering, ported from blessing/texture-renderer
 * (SkinRenderer / Point / Polygon) so previews and avatars match the legacy
 * PHP site's orthographic composition, per-texel quads, painter's display order
 * and 2x supersampling. Slim arm UVs and HD overlays fix defects in the old port
 * and agree with the interactive skinview3d model.
 */

type RGBA = [number, number, number, number];
type Pt = [number, number, number];
type FaceName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';
type Quad = { p: Pt[]; color: RGBA; face: FaceName };

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Parse a PNG, tolerating trailing bytes after IEND (GD accepted such files). */
function parsePng(data: Buffer): PNG {
  const iend = data.indexOf(Buffer.from('IEND', 'ascii'));
  if (iend !== -1 && iend + 8 <= data.length) {
    try {
      return PNG.sync.read(data.subarray(0, iend + 8));
    } catch { /* fall through to the strict read */ }
  }
  return PNG.sync.read(data);
}
/** Orthographic projection from Point::project(). */
function project(x: number, y: number, z: number, ca: number, sa: number, cw: number, sw: number): Pt {
  return [x * cw + z * sw, x * sa * sw + y * ca - z * sa * cw, -x * ca * sw + y * sa + z * ca * cw];
}

function px(skin: PNG, x: number, y: number): RGBA {
  const i = (y * skin.width + x) * 4;
  return [skin.data[i], skin.data[i + 1], skin.data[i + 2], skin.data[i + 3]];
}

/** PHP makeBackgroundTransparent(): remove a solid 8x8 top-left background. */
function makeBackgroundTransparent(skin: PNG): void {
  let ref: [number, number, number] | null = null;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const [r, g, b, a] = px(skin, x, y);
      if (a < 14) return; // already transparent content, nothing to remove
      if (!ref) ref = [r, g, b];
      else if (ref[0] !== r || ref[1] !== g || ref[2] !== b) return;
    }
  }
  if (!ref) return;
  for (let i = 0; i < skin.width * skin.height; i++) {
    const o = i * 4;
    if (skin.data[o + 3] >= 254 && skin.data[o] === ref[0] && skin.data[o + 1] === ref[1] && skin.data[o + 2] === ref[2]) skin.data[o + 3] = 0;
  }
}

/** PHP fixNewSkinTypeLayers(): composite 1.8 overlay rows onto the base rows. */
function fixNewSkinTypeLayers(skin: PNG): void {
  const hd = skin.width / 64;
  const composite = (dx: number, dy: number, sx: number, sy: number, w: number, h: number) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = ((sy + y) * skin.width + sx + x) * 4, di = ((dy + y) * skin.width + dx + x) * 4;
        const a = skin.data[si + 3] / 255;
        if (a >= 1) { for (let c = 0; c < 4; c++) skin.data[di + c] = skin.data[si + c]; continue; }
        if (a <= 0) continue;
        const dA = skin.data[di + 3] / 255, outA = a + dA * (1 - a);
        for (let c = 0; c < 3; c++) skin.data[di + c] = Math.round((skin.data[si + c] * a + skin.data[di + c] * dA * (1 - a)) / outA);
        skin.data[di + 3] = Math.round(outA * 255);
      }
    }
  };
  const scaled = (dx: number, dy: number, sx: number, sy: number, w: number, h: number) => composite(dx * hd, dy * hd, sx * hd, sy * hd, w * hd, h * hd);
  scaled(0, 16, 0, 32, 56, 16); // RL2, BODY2, RA2
  scaled(16, 48, 0, 48, 16, 16); // LL2
  scaled(32, 48, 48, 48, 16, 16); // LA2
}

type MemberName = 'head' | 'helmet' | 'torso' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';

/** Per-texel quads for a box face; UVs follow the legacy layout and skinview3d. */
function boxFace(
  out: Quad[], face: FaceName,
  i0: number, i1: number, j0: number, j1: number, k0: number, k1: number,
  point: (i: number, j: number, k: number) => Pt, color: (i: number, j: number, k: number) => RGBA,
): void {
  const quad = (a: Pt, b: Pt, c: Pt, d: Pt, q: RGBA) => out.push({ p: [a, b, c, d], color: q, face });
  if (face === 'front' || face === 'back') {
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
      const z = face === 'back' ? k0 : k1;
      quad(point(i, j, z), point(i + 1, j, z), point(i + 1, j + 1, z), point(i, j + 1, z), color(i, j, z));
    }
  } else if (face === 'right' || face === 'left') {
    for (let j = j0; j < j1; j++) for (let k = k0; k < k1; k++) {
      const x = face === 'right' ? i0 : i1;
      quad(point(x, j, k), point(x, j, k + 1), point(x, j + 1, k + 1), point(x, j + 1, k), color(x, j, k));
    }
  } else {
    for (let i = i0; i < i1; i++) for (let k = k0; k < k1; k++) {
      const y = face === 'top' ? j0 : j1;
      quad(point(i, y, k), point(i + 1, y, k), point(i + 1, y, k + 1), point(i, y, k + 1), color(i, y, k));
    }
  }
}

function generateMembers(skin: PNG, hd: number, headOnly: boolean, isAlex: boolean, isNewSkinType: boolean): Record<MemberName, Quad[]> {
  const r = hd;
  const at = (x: number, y: number): RGBA => px(skin, Math.round(x), Math.round(y));
  const members = { head: [] as Quad[], helmet: [] as Quad[], torso: [] as Quad[], rightArm: [] as Quad[], leftArm: [] as Quad[], rightLeg: [] as Quad[], leftLeg: [] as Quad[] };

  // HEAD: box x [0,8], y [0,8], z [-2,6]
  {
    const P = (i: number, j: number, k: number): Pt => [i, j, k];
    boxFace(members.head, 'back', 0, 8 * r, 0, 8 * r, -2 * r, 6 * r, P, (i, j) => at(32 * r - 1 - i, 8 * r + j));
    boxFace(members.head, 'front', 0, 8 * r, 0, 8 * r, -2 * r, 6 * r, P, (i, j) => at(8 * r + i, 8 * r + j));
    boxFace(members.head, 'right', 0, 0, 0, 8 * r, -2 * r, 6 * r, P, (_i, j, k) => at(k + 2 * r, 8 * r + j));
    boxFace(members.head, 'left', 8 * r, 8 * r, 0, 8 * r, -2 * r, 6 * r, P, (_i, j, k) => at(24 * r - 1 - k - 2 * r, 8 * r + j));
    boxFace(members.head, 'top', 0, 8 * r, 0, 0, -2 * r, 6 * r, P, (i, _j, k) => at(8 * r + i, k + 2 * r));
    boxFace(members.head, 'bottom', 0, 8 * r, 8 * r, 8 * r, -2 * r, 6 * r, P, (i, _j, k) => at(16 * r + i, 2 * r + k));
  }

  // Shared helmet vertices match PHP's front/back planes and expanded side/cap points.
  {
    const expandedZ = (k: number) => k === -2 * r ? -2.5 * r : k === 6 * r ? 6.5 * r : k * 9 / 8 - 0.5 * r;
    const f = (i: number, j: number, k: number): Pt => [i * 9 / 8 - 0.5 * r, j * 9 / 8 - 0.5 * r, expandedZ(k)];
    const side = (x: number) => (_i: number, j: number, k: number): Pt => [x, j * 9 / 8 - 0.5 * r, expandedZ(k)];
    const cap = (y: number) => (i: number, _j: number, k: number): Pt => [i * 9 / 8 - 0.5 * r, y, expandedZ(k)];
    boxFace(members.helmet, 'back', 0, 8 * r, 0, 8 * r, -2 * r, 6 * r, f, (i, j) => at(64 * r - 1 - i, 8 * r + j));
    boxFace(members.helmet, 'front', 0, 8 * r, 0, 8 * r, -2 * r, 6 * r, f, (i, j) => at(40 * r + i, 8 * r + j));
    boxFace(members.helmet, 'right', 0, 0, 0, 8 * r, -2 * r, 6 * r, side(-0.5 * r), (_i, j, k) => at(32 * r + k + 2 * r, 8 * r + j));
    boxFace(members.helmet, 'left', 8 * r, 8 * r, 0, 8 * r, -2 * r, 6 * r, side(8.5 * r), (_i, j, k) => at(32 * r + 24 * r - 1 - k - 2 * r, 8 * r + j));
    boxFace(members.helmet, 'top', 0, 8 * r, 0, 0, -2 * r, 6 * r, cap(-0.5 * r), (i, _j, k) => at(40 * r + i, k + 2 * r));
    boxFace(members.helmet, 'bottom', 0, 8 * r, 8 * r, 8 * r, -2 * r, 6 * r, cap(8.5 * r), (i, _j, k) => at(48 * r + i, 2 * r + k));
  }

  if (!headOnly) {
    // TORSO: x [0,8], y [8,20], z [0,4]
    {
      const P = (i: number, j: number, k: number): Pt => [i, j + 8 * r, k];
      boxFace(members.torso, 'back', 0, 8 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(40 * r - 1 - i, 20 * r + j));
      boxFace(members.torso, 'front', 0, 8 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(20 * r + i, 20 * r + j));
      boxFace(members.torso, 'right', 0, 0, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(16 * r + k, 20 * r + j));
      boxFace(members.torso, 'left', 8 * r, 8 * r, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(32 * r - 1 - k, 20 * r + j));
      boxFace(members.torso, 'top', 0, 8 * r, 0, 0, 0, 4 * r, P, (i, _j, k) => at(20 * r + i, 16 * r + k));
      boxFace(members.torso, 'bottom', 0, 8 * r, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(28 * r + i, 20 * r - 1 - k));
    }

    // RIGHT ARM: x [-4,0], y [8,20], z [0,4] (width 3 for alex)
    {
      const armI = isAlex ? 3 * r : 4 * r;
      const P = (i: number, j: number, k: number): Pt => [i - armI, j + 8 * r, k];
      const backX = (i: number) => isAlex ? 54 * r - 1 - i : 56 * r - 1 - i;
      boxFace(members.rightArm, 'back', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(backX(i), 20 * r + j));
      boxFace(members.rightArm, 'front', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(44 * r + i, 20 * r + j));
      const rightX = 40 * r, leftX = isAlex ? 51 * r : 52 * r;
      boxFace(members.rightArm, 'right', 0, 0, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(rightX + k, 20 * r + j));
      boxFace(members.rightArm, 'left', armI, armI, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(leftX - 1 - k, 20 * r + j));
      boxFace(members.rightArm, 'top', 0, armI, 0, 0, 0, 4 * r, P, (i, _j, k) => at(44 * r + i, 16 * r + k));
      boxFace(members.rightArm, 'bottom', 0, armI, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at((isAlex ? 47 : 48) * r + i, 16 * r + k));
    }

    // LEFT ARM: x [8,12], y [8,20], z [0,4]
    {
      const armI = isAlex ? 3 * r : 4 * r;
      const P = (i: number, j: number, k: number): Pt => [i + 8 * r, j + 8 * r, k];
      if (isAlex) {
        boxFace(members.leftArm, 'back', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(46 * r - 1 - i, 52 * r + j));
        boxFace(members.leftArm, 'front', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(36 * r + i, 52 * r + j));
      } else if (isNewSkinType) {
        boxFace(members.leftArm, 'back', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(47 * r - i, 52 * r + j));
        boxFace(members.leftArm, 'front', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(36 * r + i, 52 * r + j));
      } else {
        boxFace(members.leftArm, 'back', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(52 * r + i, 20 * r + j));
        boxFace(members.leftArm, 'front', 0, armI, 0, 12 * r, 0, 4 * r, P, (i, j) => at(44 * r + (4 * r - 1) - i, 20 * r + j));
      }
      boxFace(members.leftArm, 'right', 0, 0, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => isNewSkinType || isAlex ? at(32 * r + k, 52 * r + j) : at(44 * r - 1 - k, 20 * r + j));
      boxFace(members.leftArm, 'left', armI, armI, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => isNewSkinType || isAlex ? at((isAlex ? 42 : 43) * r - k, 52 * r + j) : at(48 * r + k, 20 * r + j));
      if (isAlex) {
        boxFace(members.leftArm, 'top', 0, armI, 0, 0, 0, 4 * r, P, (i, _j, k) => at(36 * r + i, 48 * r + k));
        boxFace(members.leftArm, 'bottom', 0, armI, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(39 * r + i, 48 * r + k));
      } else if (isNewSkinType) {
        boxFace(members.leftArm, 'top', 0, armI, 0, 0, 0, 4 * r, P, (i, _j, k) => at(36 * r + i, 48 * r + k));
        boxFace(members.leftArm, 'bottom', 0, armI, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(40 * r + i, 48 * r + k));
      } else {
        boxFace(members.leftArm, 'top', 0, armI, 0, 0, 0, 4 * r, P, (i, _j, k) => at(44 * r + (4 * r - 1) - i, 16 * r + k));
        boxFace(members.leftArm, 'bottom', 0, armI, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(48 * r + (4 * r - 1) - i, 20 * r - 1 - k));
      }
    }

    // RIGHT LEG: x [0,4], y [20,32], z [0,4]
    {
      const P = (i: number, j: number, k: number): Pt => [i, j + 20 * r, k];
      boxFace(members.rightLeg, 'back', 0, 4 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(16 * r - 1 - i, 20 * r + j));
      boxFace(members.rightLeg, 'front', 0, 4 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(4 * r + i, 20 * r + j));
      boxFace(members.rightLeg, 'right', 0, 0, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(k, 20 * r + j));
      boxFace(members.rightLeg, 'left', 4 * r, 4 * r, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(12 * r - 1 - k, 20 * r + j));
      boxFace(members.rightLeg, 'top', 0, 4 * r, 0, 0, 0, 4 * r, P, (i, _j, k) => at(4 * r + i, 16 * r + k));
      boxFace(members.rightLeg, 'bottom', 0, 4 * r, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(8 * r + i, 16 * r + k));
    }

    // LEFT LEG: x [4,8], y [20,32], z [0,4]
    {
      const P = (i: number, j: number, k: number): Pt => [i + 4 * r, j + 20 * r, k];
      if (isNewSkinType) {
        boxFace(members.leftLeg, 'back', 0, 4 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(31 * r - i, 52 * r + j));
        boxFace(members.leftLeg, 'front', 0, 4 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(20 * r + i, 52 * r + j));
        boxFace(members.leftLeg, 'right', 0, 0, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(16 * r + k, 52 * r + j));
        boxFace(members.leftLeg, 'left', 4 * r, 4 * r, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(27 * r - k, 52 * r + j));
        boxFace(members.leftLeg, 'top', 0, 4 * r, 0, 0, 0, 4 * r, P, (i, _j, k) => at(20 * r + i, 48 * r + k));
        boxFace(members.leftLeg, 'bottom', 0, 4 * r, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(24 * r + i, 48 * r + k));
      } else {
        boxFace(members.leftLeg, 'back', 0, 4 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(12 * r + i, 20 * r + j));
        boxFace(members.leftLeg, 'front', 0, 4 * r, 0, 12 * r, 0, 4 * r, P, (i, j) => at(8 * r - 1 - i, 20 * r + j));
        boxFace(members.leftLeg, 'right', 0, 0, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(4 * r - 1 - k, 20 * r + j));
        boxFace(members.leftLeg, 'left', 4 * r, 4 * r, 0, 12 * r, 0, 4 * r, P, (_i, j, k) => at(8 * r + k, 20 * r + j));
        boxFace(members.leftLeg, 'top', 0, 4 * r, 0, 0, 0, 4 * r, P, (i, _j, k) => at(8 * r - 1 - i, 16 * r + k));
        boxFace(members.leftLeg, 'bottom', 0, 4 * r, 12 * r, 12 * r, 0, 4 * r, P, (i, _j, k) => at(12 * r - 1 - i, 20 * r - 1 - k));
      }
    }
  }
  return members;
}

const ALL_FACES = ['back', 'right', 'top', 'front', 'left', 'bottom'] as const;

/** Unit-cube hidden-face set for the given rotation (Point depth test as in PHP). */
function hiddenFaces(ca: number, sa: number, cw: number, sw: number): string[] {
  let minDepth = Infinity, back: string[] = ALL_FACES.slice(0, 3) as unknown as string[];
  const corners: Array<[Pt, string[]]> = [
    [[0, 0, 0], ['back', 'right', 'top']], [[0, 0, 1], ['front', 'right', 'top']],
    [[0, 1, 0], ['back', 'right', 'bottom']], [[0, 1, 1], ['front', 'right', 'bottom']],
    [[1, 0, 0], ['back', 'left', 'top']], [[1, 0, 1], ['front', 'left', 'top']],
    [[1, 1, 0], ['back', 'left', 'bottom']], [[1, 1, 1], ['front', 'left', 'bottom']],
  ];
  for (const [c, faces] of corners) {
    const depth = project(c[0], c[1], c[2], ca, sa, cw, sw)[2];
    if (depth < minDepth) { minDepth = depth; back = faces; }
  }
  return back;
}

/** Fill one flat-coloured parallelogram (affine texture mapping of a projected texel quad). */
function fillQuad(canvas: PNG, pts: Array<[number, number]>, color: RGBA): void {
  const [p0, p1, p2] = pts;
  const p3: [number, number] = [p0[0] + p2[0] - p1[0], p0[1] + p2[1] - p1[1]];
  const e1 = [p1[0] - p0[0], p1[1] - p0[1]], e2 = [p3[0] - p0[0], p3[1] - p0[1]];
  const det = e1[0] * e2[1] - e1[1] * e2[0];
  if (det === 0) return;
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p2[0], p1[0], p3[0])));
  const maxX = Math.min(canvas.width - 1, Math.ceil(Math.max(p0[0], p2[0], p1[0], p3[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p2[1], p1[1], p3[1])));
  const maxY = Math.min(canvas.height - 1, Math.ceil(Math.max(p0[1], p2[1], p1[1], p3[1])));
  if (maxX < minX || maxY < minY) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5 - p0[0], cy = y + 0.5 - p0[1];
      const s = (cx * e2[1] - cy * e2[0]) / det, t = (cy * e1[0] - cx * e1[1]) / det;
      if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
      const i = (y * canvas.width + x) * 4;
      canvas.data[i] = color[0]; canvas.data[i + 1] = color[1]; canvas.data[i + 2] = color[2]; canvas.data[i + 3] = 255;
    }
  }
}

function downscale2(src: PNG): PNG {
  const w = Math.floor(src.width / 2), h = Math.floor(src.height / 2);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const i = ((y * 2 + oy) * src.width + x * 2 + ox) * 4, sa = src.data[i + 3] / 255;
        r += src.data[i] * sa; g += src.data[i + 1] * sa; b += src.data[i + 2] * sa; a += sa;
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a); out.data[o + 1] = Math.round(g / a); out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round((a / 4) * 255);
      }
    }
  }
  return out;
}

export type RenderResult = { png: PNG; width: number; height: number };

/**
 * Port of SkinRenderer::render(). ratio is the legacy scale factor; angles in
 * degrees. The projection tracks exact min/max bounds so the canvas matches
 * the PHP output size.
 */
export function renderSkin3d(data: Buffer, ratio: number, headOnly: boolean, hR: number, vR: number, isAlex: boolean, layers = true): RenderResult {
  const original = parsePng(data);
  const skin = original.width > 256 ? resample(original, 256, Math.round(original.height * 256 / original.width)) : original;
  const hd = skin.width / 64;
  const isNewSkinType = skin.width === skin.height;
  makeBackgroundTransparent(skin);
  if (layers && isNewSkinType) fixNewSkinTypeLayers(skin);

  const ca = Math.cos(rad(vR)), sa = Math.sin(rad(vR)), cw = Math.cos(rad(hR)), sw = Math.sin(rad(hR));
  const members = generateMembers(skin, hd, headOnly, isAlex, isNewSkinType);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const quads of Object.values(members)) {
    for (const quad of quads) {
      for (const [x, y, z] of quad.p) {
        const [px2, py2] = project(x, y, z, ca, sa, cw, sw);
        if (px2 < minX) minX = px2; if (px2 > maxX) maxX = px2;
        if (py2 < minY) minY = py2; if (py2 > maxY) maxY = py2;
      }
    }
  }
  if (!Number.isFinite(minX)) return { png: new PNG({ width: 1, height: 1 }), width: 1, height: 1 };

  const scale = ratio * 2;
  const W = Math.floor((maxX - minX) * scale) + 1, H = Math.floor((maxY - minY) * scale) + 1;
  const canvas = new PNG({ width: Math.max(1, W), height: Math.max(1, H) });

  const globalBack = hiddenFaces(ca, sa, cw, sw);
  const globalFront = ALL_FACES.filter((f) => !globalBack.includes(f));
  const hasTop = globalFront.includes('top'), hasRight = globalFront.includes('right');
  type Step = Array<[MemberName, string[]]>;
  const step = (member: MemberName, faces: string[]): [MemberName, string[]] => [member, faces];
  const order: Step[] = [];
  if (hasTop) {
    if (hasRight) {
      order.push([step('leftLeg', globalBack), step('leftLeg', globalFront), step('rightLeg', globalBack), step('rightLeg', globalFront),
        step('leftArm', globalBack), step('leftArm', globalFront), step('torso', globalBack), step('torso', globalFront),
        step('rightArm', globalBack), step('rightArm', globalFront)]);
    } else {
      order.push([step('rightLeg', globalBack), step('rightLeg', globalFront), step('leftLeg', globalBack), step('leftLeg', globalFront),
        step('rightArm', globalBack), step('rightArm', globalFront), step('torso', globalBack), step('torso', globalFront),
        step('leftArm', globalBack), step('leftArm', globalFront)]);
    }
    order.push([step('helmet', globalBack), step('head', globalBack), step('head', globalFront), step('helmet', globalFront)]);
  } else {
    order.push([step('helmet', globalBack), step('head', globalBack), step('head', globalFront), step('helmet', globalFront)]);
    if (hasRight) {
      order.push([step('leftArm', globalBack), step('leftArm', globalFront), step('torso', globalBack), step('torso', globalFront),
        step('rightArm', globalBack), step('rightArm', globalFront), step('leftLeg', globalBack), step('leftLeg', globalFront),
        step('rightLeg', globalBack), step('rightLeg', globalFront)]);
    } else {
      order.push([step('rightArm', globalBack), step('rightArm', globalFront), step('torso', globalBack), step('torso', globalFront),
        step('leftArm', globalBack), step('leftArm', globalFront), step('rightLeg', globalBack), step('rightLeg', globalFront),
        step('leftLeg', globalBack), step('leftLeg', globalFront)]);
    }
  }

  for (const steps of order) {
    for (const [member, faces] of steps) {
      const quads = members[member];
      if (!quads.length) continue;
      for (const quad of quads) {
        if (!faces.includes(quad.face)) continue;
        // PHP skips texels with GD alpha 127 (PNG alpha < 2); the rest draw opaque.
        if (quad.color[3] < 2) continue;
        const pts = quad.p.map(([x, y, z]) => {
          const projected = project(x, y, z, ca, sa, cw, sw);
          return [(projected[0] - minX) * scale, (projected[1] - minY) * scale] as [number, number];
        });
        // PHP skips polygons whose projected points share one x or one y plane.
        const sameX = pts.every((p) => p[0] === pts[0][0]), sameY = pts.every((p) => p[1] === pts[0][1]);
        if (sameX || sameY) continue;
        fillQuad(canvas, pts, quad.color);
      }
    }
  }
  const out = downscale2(canvas);
  return { png: out, width: out.width, height: out.height };
}

export function pngToBuffer(render: RenderResult): Buffer {
  return PNG.sync.write(render.png, { colorType: 6 });
}

/** Legacy Minecraft::render2dAvatar(): flat head, no rotation. */
export function render2dAvatar(data: Buffer, ratio = 15): RenderResult {
  return renderSkin3d(data, ratio, true, 0, 0, false);
}

/** Legacy Minecraft::render3dAvatar(): isometric head at 45 degrees. */
export function render3dAvatar(data: Buffer, ratio = 15): RenderResult {
  return renderSkin3d(data, ratio, true, 45, -25, false);
}

/** Legacy Minecraft::renderSkin(): two isometric full-body views, back then front. */
export function renderSkin(data: Buffer, ratio = 12, isAlex = false): RenderResult {
  const back = renderSkin3d(data, ratio, false, 135, -25, isAlex);
  const front = renderSkin3d(data, ratio, false, -45, -25, isAlex);
  const hp = 30, vp = 15, ip = 15;
  const canvas = new PNG({ width: (hp + front.width + ip) * 2, height: vp * 2 + front.height });
  const copy = (src: PNG, dx: number, dy: number) => {
    for (let y = 0; y < Math.min(src.height, front.height); y++) {
      for (let x = 0; x < Math.min(src.width, front.width); x++) {
        const si = (y * src.width + x) * 4;
        if (src.data[si + 3] === 0) continue;
        const di = ((dy + y) * canvas.width + dx + x) * 4;
        const sa = src.data[si + 3] / 255, dA = canvas.data[di + 3] / 255, outA = sa + dA * (1 - sa);
        if (outA === 0) continue;
        for (let c = 0; c < 3; c++) canvas.data[di + c] = Math.round((src.data[si + c] * sa + canvas.data[di + c] * dA * (1 - sa)) / outA);
        canvas.data[di + 3] = Math.round(outA * 255);
      }
    }
  };
  copy(back.png, hp, vp);
  copy(front.png, hp + front.width + ip * 2, vp);
  return { png: canvas, width: canvas.width, height: canvas.height };
}

/** Legacy Minecraft::renderCape(): cape front scaled to `height`, padded canvas. */
export function renderCape(data: Buffer, height: number): RenderResult {
  const cape = parsePng(data);
  const hdRatio = cape.width / 64;
  const outHeight = Math.max(1, Math.round(height)), outWidth = Math.max(1, Math.round(outHeight / 16 * 10));
  const scaled = resample(cape, outWidth, outHeight, 1 * hdRatio, 1 * hdRatio, cape.width * 10 / 64, cape.height * 16 / 32);
  const hp = 40, vp = 20;
  const canvas = new PNG({ width: hp * 2 + scaled.width, height: vp * 2 + scaled.height });
  for (let y = 0; y < scaled.height; y++) {
    for (let x = 0; x < scaled.width; x++) {
      const si = (y * scaled.width + x) * 4;
      if (scaled.data[si + 3] === 0) continue;
      const di = ((vp + y) * canvas.width + hp + x) * 4;
      for (let c = 0; c < 4; c++) canvas.data[di + c] = scaled.data[si + c];
    }
  }
  return { png: canvas, width: canvas.width, height: canvas.height };
}

function resample(src: PNG, w: number, h: number, sx0 = 0, sy0 = 0, sxW = src.width, sxH = src.height): PNG {
  const out = new PNG({ width: w, height: h });
  const rx = sxW / w, ry = sxH / h;
  const at = (x: number, y: number): RGBA => {
    const cx = Math.min(src.width - 1, Math.max(0, x)), cy = Math.min(src.height - 1, Math.max(0, y));
    const i = (cy * src.width + cx) * 4;
    return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx0 = sx0 + (x + 0.5) * rx - 0.5, fy0 = sy0 + (y + 0.5) * ry - 0.5;
      const x0 = Math.floor(fx0), y0 = Math.floor(fy0), fx = fx0 - x0, fy = fy0 - y0;
      const c00 = at(x0, y0), c10 = at(x0 + 1, y0), c01 = at(x0, y0 + 1), c11 = at(x0 + 1, y0 + 1);
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = c00[c] * (1 - fx) + c10[c] * fx, bottom = c01[c] * (1 - fx) + c11[c] * fx;
        out.data[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/** Resize any rendered result to an exact square, like the legacy resize(). */
export function resizeTo(render: RenderResult, size: number): RenderResult {
  if (render.width === size && render.height === size) return render;
  const out = resample(render.png, size, size);
  return { png: out, width: size, height: size };
}

let default2d: Buffer | null = null, default3d: Buffer | null = null;
function defaultAvatarBuffer(mode: '2d' | '3d'): Buffer | null {
  if (mode === '2d' && default2d) return default2d;
  if (mode === '3d' && default3d) return default3d;
  try {
    const file = path.join(ROOT_DIR, 'storage', 'misc', mode === '3d' ? 'avatar3d.png' : 'avatar2d.png');
    const data = fs.readFileSync(file);
    if (mode === '2d') default2d = data; else default3d = data;
    return data;
  } catch { return null; }
}

/** Legacy default avatar: the bundled misc image resized to the request size. */
export function defaultAvatar(size: number, mode: '2d' | '3d' = '2d'): RenderResult {
  const file = defaultAvatarBuffer(mode);
  if (file) {
    try {
      const png = parsePng(file);
      return resizeTo({ png, width: png.width, height: png.height }, size);
    } catch { /* fall through to the built-in placeholder */ }
  }
  const out = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    out.data[i * 4] = 0xe5; out.data[i * 4 + 1] = 0xe5; out.data[i * 4 + 2] = 0xe5; out.data[i * 4 + 3] = 255;
  }
  return { png: out, width: size, height: size };
}

export async function loadTextureData(hash: string): Promise<Buffer | null> {
  if (!(await textureExists(hash))) return null;
  return readTextureFile(hash);
}
