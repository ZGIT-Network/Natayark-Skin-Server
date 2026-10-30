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
console.log('client bundles built');
