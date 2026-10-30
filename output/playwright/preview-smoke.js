async page=>{
 const ensure=(v,m)=>{if(!v)throw new Error(m);};
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('http://127.0.0.1:3000/skinlib/upload');
 const viewer=page.locator('[data-skin-viewer]');
 await page.locator('[data-viewer-status]').waitFor({state:'hidden'});
 ensure(await viewer.getAttribute('data-loading')==='false','3D skeleton remains after load');
 await page.locator('#file').setInputFiles('D:/Projects/MCNSKIN/public/app/default-skin.png');
 await page.locator('#model').selectOption('slim');
 await page.waitForFunction(()=>document.querySelector('[data-skin-viewer]').__viewer.playerObject.skin.modelType==='slim');
 await viewer.getByRole('button',{name:'切换行走与奔跑',exact:true}).click();
 ensure(await viewer.getAttribute('data-animation')==='run','Animation switch');
 await viewer.getByRole('button',{name:'2D',exact:true}).click();
 await viewer.getByRole('button',{name:'3D',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>document.querySelector('[data-sidebar]').getBoundingClientRect().right<=0);
 ensure(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile viewer overflows');
 ensure(await viewer.locator('.viewer-loading').isHidden(),'Viewer stays covered by loading skeleton');
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('http://127.0.0.1:3000/skinlib/show/155');
 await page.locator('[data-viewer-status]').waitFor({state:'hidden'});
 await page.screenshot({path:'output/playwright/material-interactive-preview.png',fullPage:true});
 ensure(errors.length===0,errors.join('\n'));
 return{localPreview:true,slim:true,animation:true,skeletonClears:true,mobile:true,uploaded:false,errors};
}
