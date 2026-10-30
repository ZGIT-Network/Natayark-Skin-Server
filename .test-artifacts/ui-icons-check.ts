import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { icon } from '../src/icons.js';
function walk(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const names = new Set<string>();
for (const file of walk('src/views').filter(f => f.endsWith('.ejs'))) {
  const template = fs.readFileSync(file, 'utf8');
  for (const match of template.matchAll(/icon\('([^']+)'/g)) names.add(match[1]);
}
for (const name of names) assert.match(icon(name), /class="xicon /, name);
assert.equal(icon('../../secret'), '');
console.log(`${names.size} used xicons resolved`);
