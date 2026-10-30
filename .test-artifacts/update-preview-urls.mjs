import fs from 'node:fs';
for (const file of ['src/views/home.ejs','src/views/skinlib/index.ejs','src/views/user/closet.ejs','src/views/user/players.ejs','src/views/user/index.ejs']) {
  let source = fs.readFileSync(file,'utf8');
  source = source.replaceAll('/preview/hash/<%= item.hash %>?size=', '/preview/<%= item.tid %>?model=<%= item.type %>&size=');
  source = source.replaceAll('/preview/hash/<%= p.skinHash %>?size=', '/preview/<%= p.skinTid %>?model=<%= p.model %>&size=');
  fs.writeFileSync(file,source);
}
