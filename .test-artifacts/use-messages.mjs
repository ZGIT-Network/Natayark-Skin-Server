import fs from 'node:fs';
const app='public/js/app.js';
fs.writeFileSync(app,fs.readFileSync(app,'utf8').replaceAll('toast(','message(').replaceAll('window.UI.toast','window.UI.message'));
const ui='public/js/ui.js';
fs.writeFileSync(ui,fs.readFileSync(ui,'utf8').replaceAll("toast('已复制", "message('已复制").replaceAll("toast('复制失败", "message('复制失败"));
for(const file of ['src/views/admin/settings.ejs','src/views/user/verification.ejs']){
 let text=fs.readFileSync(file,'utf8');
 const content=file.includes('/admin/')?'已保存。':'正版验证已完成。';
 text=text.replace('class="alert alert-success mb-5" role="status"','class="alert alert-success mb-5" role="status" data-feedback-message="'+content+'"');
 fs.writeFileSync(file,text);
}
