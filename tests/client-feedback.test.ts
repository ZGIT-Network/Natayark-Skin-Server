import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function setup(kind:'sign'|'form-error') {
  const calls:Array<[string,string]>=[], handlers:Record<string,Function>={};
  const button={disabled:false,addEventListener(event:string,fn:Function){handlers[event]=fn;}};
  const score={textContent:'100'}, label={textContent:''};
  const form={addEventListener(event:string,fn:Function){handlers[event]=fn;},querySelector(selector:string){return selector==='[name="name"]'?{value:'duplicate'}:selector==='[type="submit"]'?button:null;}};
  const document={
    getElementById(id:string){return kind==='sign'?(id==='sign-btn'?button:id==='sign-msg'?label:null):null;},
    querySelector(selector:string){return selector==='[data-user-score]'?score:null;},
    querySelectorAll(selector:string){return kind==='form-error'&&selector==='form[data-action="add-player"]'?[form]:[];},
    addEventListener(){},
  };
  vm.runInNewContext(source,{document,window:{__CSRF:'test',UI:{message:(content:string,type:string)=>calls.push([content,type])}},setTimeout,URLSearchParams,
    fetch:async()=>({ok:kind==='sign',status:kind==='sign'?200:400,json:async()=>kind==='sign'?{code:0,message:'签到成功',acquired:10}:{code:1,message:'角色名已存在'}})});
  return{calls,handlers,button,score,label};
}
test('sign-in updates the score and shows a message without a callback name collision',async()=>{
  const ui=setup('sign');ui.handlers.click();await flush();
  assert.equal(ui.score.textContent,'110');assert.equal(ui.label.textContent,'今天已签到');
  assert.deepEqual(ui.calls,[['签到成功','success']]);
});
test('JSON form errors without an inline field produce an error message',async()=>{
  const ui=setup('form-error');ui.handlers.submit({preventDefault(){}});await flush();
  assert.equal(ui.button.disabled,false);
  assert.deepEqual(ui.calls,[['角色名已存在','error']]);
});
