import fs from 'node:fs';
const root = 'D:/Projects/mcnskinl/oldbf/public/app/';
for (const name of ['115.861bead.js','403.277e7ba.js','414.5f8b587.js','512.982d457.js','app.672e119.js']) {
  const source = fs.readFileSync(root + name, 'utf8');
  const terms = ['previewer','animationSpeed','autoRotate','animation-speed','skinview','rotationSpeed','Walking','show-ears','cape'];
  console.log('\nFILE', name, source.length);
  for (const term of terms) {
    const index = source.indexOf(term);
    if (index >= 0) console.log(term, source.slice(Math.max(0,index-220), index+460));
  }
}
