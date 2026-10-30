async page=>{
  await page.addInitScript(()=>{addEventListener('pagereveal',event=>{window.__trans={exists:!!event.viewTransition};if(event.viewTransition){event.viewTransition.ready.then(()=>window.__trans.ready=true,error=>window.__trans.error=error.message)}})});
  await page.goto('http://127.0.0.1:3000/user');
  await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState!=='running'));
  await page.locator('a[href="/user/player"]').first().click();
  await page.waitForURL('**/user/player');
  await page.waitForFunction(()=>window.__trans);
  return await page.evaluate(()=>window.__trans);
}
