import fs from 'node:fs';
const file = 'src/views/home.ejs';
let content = fs.readFileSync(file, 'utf8');
const labels = {
  '主导航': 'navigation', 'Minecraft 皮肤站': 'kind', '管理你的游戏角色、皮肤与披风。': 'description',
  '浏览皮肤库': 'browse', '最近上传': 'recent', '社区分享的皮肤与披风': 'community', '全部材质': 'all',
  '还没有公开材质。': 'empty', 'Minecraft 游戏场景': 'image', '设置游戏皮肤': 'players',
  '上传或收藏材质，然后在角色管理中应用。': 'players-help', '连接启动器': 'connect',
  '使用支持外置登录的启动器，添加本站认证服务。': 'connect-help', '查看配置': 'config',
  '管理账户': 'account', '修改个人资料、绑定登录方式，管理应用授权。': 'account-help', '账户设置': 'settings',
};
// The description expression needs a JS string expression, rather than a nested EJS tag.
content = content.replace("siteDescription || '管理你的游戏角色、皮肤与披风。'", "siteDescription || t('home.description')");
for (const [label, key] of Object.entries(labels)) content = content.replaceAll(label, `<%= t('home.${key}') %>`);
content = content.replace('>上传皮肤</a>', "><%= t('skinlib.upload') %></a>")
  .replace('>角色管理</a>', "><%= t('general.player-manage') %></a>")
  .replace("item.type === 'cape' ? '披风'", "item.type === 'cape' ? t('skinlib.type-cape')");
fs.writeFileSync(file, content);
