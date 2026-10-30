async page=>{
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const ensure=(v,m)=>{if(!v)throw new Error(m);};
 await page.goto('http://127.0.0.1:3000/auth/login');
 if(new URL(page.url()).pathname==='/auth/login') {
 await page.getByRole('textbox',{name:'邮箱',exact:true}).fill('review-f045c785@example.test');
 await page.getByRole('textbox',{name:'密码',exact:true}).fill('review-local-password');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.waitForURL('**/user');
 }
 const base='http://127.0.0.1:4011';
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(base+'/user');
 const sign=page.locator('#sign-btn');
 if(await sign.isEnabled()){await sign.click();await page.locator('.message-success').waitFor();}
 else await page.evaluate(()=>UI.message.success('签到状态已更新'));
 await page.locator('.message-region:popover-open').waitFor();
 const box=await page.locator('.message').first().boundingBox();
 ensure(box.y<120&&Math.abs(box.x+box.width/2-720)<2,'Message layout');
 await page.screenshot({path:'output/playwright/message-feedback.png',fullPage:false});
 await page.goto(base+'/user/sharing');
 await page.waitForURL('**/user');
 await page.locator('.message-warning').filter({hasText:'分享注册功能未启用'}).waitFor();
 await page.goto(base+'/admin/textures',{waitUntil:'domcontentloaded'});
 await page.locator('.library-preview[data-image-state="loading"]').first().waitFor();
 await page.screenshot({path:'output/playwright/library-loading-skeleton.png',fullPage:false,animations:'disabled'});
 await page.waitForFunction(()=>[...document.querySelectorAll('.library-preview')].slice(0,4).every(e=>e.dataset.imageState==='ready'));
 await page.goto(base+'/user');
 await page.evaluate(()=>{
   sessionStorage.removeItem('__skeletonObserved');
   setTimeout(()=>sessionStorage.setItem('__skeletonObserved',JSON.stringify({visible:!!document.querySelector('.page-skeleton'),inert:document.querySelector('[data-page-content]').inert})),350);
   document.querySelector('a[href="/user/profile"]').click();
 });
 await page.waitForURL('**/user/profile');
 const observed=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('__skeletonObserved')||'{}'));
 ensure(observed.visible&&observed.inert,'Delayed navigation did not show a skeleton');
 ensure(await page.locator('.page-skeleton').count()===0,'Stale loading skeleton');
 await page.waitForFunction(()=>document.getAnimations().every(e=>e.playState!=='running'));
 ensure(await page.locator('[data-page-content]').evaluate(e=>getComputedStyle(e).transform)==='none','Page transforms');
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>UI.message.error('这是用于检查窄屏布局的操作反馈。'.repeat(10)));
 ensure(await page.evaluate(()=>[...document.querySelectorAll('.message')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})),'Mobile message overflow');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto(base+'/admin/textures');
 ensure(await page.locator('[data-page-content]').evaluate(e=>getComputedStyle(e).animationName)==='none','Reduced motion');
 await page.emulateMedia({reducedMotion:'no-preference'});
 ensure(errors.length===0,errors.join('\n'));
 return{messages:true,noRawSharingJson:true,imageSkeleton:true,pageSkeleton:true,mobile:true,reducedMotion:true,errors};
}
