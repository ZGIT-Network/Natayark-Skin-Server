import fs from 'node:fs';
fs.writeFileSync('src/views/skinlib/index.ejs', `<%- include('../partials/layout-user-top', { title: t('general.skinlib'), pageDescription: '浏览和收藏社区分享的皮肤与披风。' }) %>
<%- include('../partials/texture-library', { libraryBase: '/skinlib', adminMode: false }) %>
<%- include('../partials/layout-bottom') %>
`);
fs.writeFileSync('src/views/admin/textures.ejs', `<%- include('../partials/layout-user-top', { title: '材质管理', scope: 'admin', pageDescription: '浏览、编辑和管理站点中的材质。' }) %>
<%- include('../partials/texture-library', { libraryBase: '/admin/textures', adminMode: true }) %>
<%- include('../partials/layout-bottom') %>
`);
