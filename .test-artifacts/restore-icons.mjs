import fs from 'node:fs';
import path from 'node:path';
const navIcons = {
  '/admin': 'layout-dashboard', '/admin/users': 'users', '/admin/players': 'gamepad-2', '/admin/textures': 'image',
  '/admin/reports': 'flag', '/admin/clients': 'key-round', '/admin/settings': 'paintbrush', '/admin/translations': 'languages',
  '/admin/ygg-log': 'scroll-text', '/user': 'layout-dashboard', '/user/player': 'gamepad-2', '/user/closet': 'shirt',
  '/user/profile': 'user-round', '/user/connections': 'link', '/user/applications': 'code-xml', '/user/verification': 'badge-check',
  '/user/sharing': 'gift', '/skinlib': 'archive', '/auth/login': 'log-in',
};
for (const file of ['src/views/partials/sidebar.ejs', 'src/views/partials/user-menu.ejs']) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.split('\n').map(line => {
    if ((!line.includes('class="nav-item') && !line.includes('class="dropdown-item')) || line.includes('icon(')) return line;
    const href = /href="([^"]+)"/.exec(line)?.[1];
    const icon = navIcons[href] || (line.includes('type="submit"') ? 'log-out' : null);
    return icon ? line.replace('<span>', `<%- icon('${icon}') %><span>`) : line;
  }).join('\n');
  fs.writeFileSync(file, content);
}
const actionIcons = { 'add-closet':'star', 'toggle-privacy':'eye', 'delete-texture':'trash-2', 'rename-player':'pencil', 'delete-player':'trash-2', 'rename-closet':'pencil', 'remove-closet':'trash-2', 'use-texture':'shirt', 'apply-texture':'shirt', 'admin-edit-player':'pencil', 'admin-delete-player':'trash-2', 'admin-delete-texture':'trash-2', 'review-report':'check' };
function walk(dir) { return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]); }
for (const file of walk('src/views').filter(file => file.endsWith('.ejs'))) {
  let source = fs.readFileSync(file, 'utf8');
  source = source.replace(/(<button\b(?:<%[\s\S]*?%>|[^>])*>)([\s\S]*?)<\/button>/g, (full, opening, body) => {
    if (body.includes('icon(')) return full;
    const action = /data-action="([^"]+)"/.exec(opening)?.[1];
    const glyph = actionIcons[action] || (opening.includes('data-dialog-open="dialog-add"') ? 'plus' : opening.includes('data-dialog-open="dialog-report"') ? 'flag' : null);
    return glyph ? opening + `<%- icon('${glyph}') %>` + body + '</button>' : full;
  });
  fs.writeFileSync(file, source);
}
