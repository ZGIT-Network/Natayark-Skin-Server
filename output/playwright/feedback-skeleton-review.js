async page=>{
  const base='http://127.0.0.1:3000';
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const ensure=(value,message)=>{if(!value)throw new Error(message);};
  await page.unrouteAll({behavior:'ignoreErrors'});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/user');
  const sign=page.locator('#sign-btn');
  if(await sign.isEnabled()) {
    await sign.click();
    await page.locator('.message-success').waitFor();
    ensure(await sign.isDisabled(),'Sign-in did not complete');
  } else await page.evaluate(()=>UI.message.success('签到状态已更新'));
  ensure(await page.locator('.message-region').evaluate(e=>e.matches(':popover-open')),'Message is not in the top layer');
  const box=await page.locator('.message').first().boundingBox();
  ensure(box.y<120&&Math.abs(box.x+box.width/2-720)<2,'Message position is wrong');
  await page.screenshot({path:'output/playwright/message-feedback.png',fullPage:false});
  await page.goto(base+'/user/sharing');
  await page.waitForURL('**/user');
  await page.locator('.message-warning').filter({hasText:'分享注册功能未启用'}).waitFor();
  ensure(await page.locator('h1').textContent()==='仪表盘','Disabled sharing exposed raw JSON');
  let releaseImages;
  const imagesGate=new Promise(resolve=>releaseImages=resolve);
  await page.route('**/preview/**',async route=>{await imagesGate;await route.continue();});
  try {
    await page.goto(base+'/admin/textures',{waitUntil:'domcontentloaded'});
    await page.locator('.library-preview[data-image-state="loading"]').first().waitFor();
    ensure(await page.locator('.image-skeleton').first().isVisible(),'Image skeleton missing');
    await page.screenshot({path:'output/playwright/library-loading-skeleton.png',fullPage:false,animations:'disabled'});
  } finally {releaseImages();await page.unrouteAll({behavior:'wait'});}
  await page.waitForFunction(()=>[...document.querySelectorAll('.library-preview')].slice(0,4).every(e=>e.dataset.imageState==='ready'));
  let releasePage;
  const pageGate=new Promise(resolve=>releasePage=resolve);
  await page.route('**/user/profile',async route=>{await pageGate;await route.continue();});
  let navigating;
  try {
    await page.goto(base+'/user');
    navigating=page.locator('a[href="/user/profile"]').first().click();
    await page.locator('.page-skeleton').waitFor();
    ensure(await page.locator('[data-page-content]').evaluate(e=>e.inert),'Loading page is still interactive');
    await page.screenshot({path:'output/playwright/page-loading-skeleton.png',fullPage:false,animations:'disabled'});
  } finally {releasePage();await page.unrouteAll({behavior:'wait'});}
  await navigating;
  await page.waitForURL('**/user/profile');
  ensure(await page.locator('.page-skeleton').count()===0,'Skeleton survived navigation');
  await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
  ensure(await page.locator('[data-page-content]').evaluate(e=>getComputedStyle(e).transform)==='none','Page animation moves the layout');
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>UI.message.error('这是用于检查窄屏布局的操作反馈。'.repeat(10)));
  ensure(await page.evaluate(()=>[...document.querySelectorAll('.message')].every(e=>{const b=e.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth;})),'Mobile message overflow');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base+'/admin/textures');
  ensure(await page.locator('[data-page-content]').evaluate(e=>getComputedStyle(e).animationName)==='none','Reduced motion animates page');
  await page.emulateMedia({reducedMotion:'no-preference'});
  ensure(errors.length===0,errors.join('\n'));
  return{signMessage:true,disabledSharingMessage:true,imageSkeleton:true,pageSkeleton:true,noPageTransform:true,mobileMessage:true,reducedMotion:true,errors};
}
