import esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Bundle skinview3d for the texture detail page
await esbuild.build({
  entryPoints: [path.join(root, 'public', 'js', 'skinview-entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: path.join(root, 'public', 'vendor', 'skinview3d.js'),
  target: 'es2020',
});

// Copy the Inter variable font next to the compiled stylesheet.
const fontSource = path.join(root, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2');
fs.mkdirSync(path.join(root, 'public', 'fonts'), { recursive: true });
if (fs.existsSync(fontSource)) {
  fs.copyFileSync(fontSource, path.join(root, 'public', 'fonts', 'inter-latin-wght-normal.woff2'));
}

fs.mkdirSync(path.join(root, 'public', 'css'), { recursive: true });
// Bundled code and fonts retain the notices of their actual dependencies.
const licenses = path.join(root, 'public', 'licenses');
fs.mkdirSync(licenses, { recursive: true });
for (const [name, output] of [['skinview3d','skinview3d-MIT.txt'],['skinview-utils','skinview-utils-MIT.txt'],['three','three-MIT.txt'],['@fontsource-variable/inter','inter-OFL-1.1.txt']]) {
  fs.copyFileSync(path.join(root,'node_modules',name,'LICENSE'),path.join(licenses,output));
}
console.log('client bundles built');
