import fs from 'node:fs';
import { transform } from 'esbuild';
for (const name of ['997.b99f3d5.js', '846.d55824d.js','613.3837fe8.js']) {
  const input = fs.readFileSync('D:/Projects/mcnskinl/oldbf/public/app/' + name, 'utf8');
  const result = await transform(input, { loader:'js', minify:false });
  fs.writeFileSync('.test-artifacts/legacy-' + name, result.code);
}
