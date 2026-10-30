import fs from 'node:fs';
const file='public/js/app.js';
let text=fs.readFileSync(file,'utf8').replace(/(?<!\.)\bmessage\(/g,'showMessage(');
text=text.replace('function showMessage(message, isError)', 'function showMessage(content, isError)').replace('window.UI.message(message, isError', 'window.UI.message(content, isError');
fs.writeFileSync(file,text);
