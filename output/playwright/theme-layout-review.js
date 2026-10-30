async (page) => {
  const base = 'http://127.0.0.1:3000';
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(() => localStorage.removeItem('mcnskin-theme'));
  await page.emulateMedia({colorScheme:'dark'});
  await page.route('**/js/ui.js', route => route.abort());
  await page.goto(base + '/');
  ensure(await page.locator('html').getAttribute('class').then(value=>value.includes('dark')), 'Early system dark mode failed');
  await page.unroute('**/js/ui.js');
  await page.reload();
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
  const choose = async mode => {
    await page.getByRole('button',{name:'外观模式',exact:true}).click();
    await page.getByRole('menuitemradio',{name:mode,exact:true}).click();
    await page.locator('[data-theme-menu] [data-dropdown-menu]').waitFor({state:'hidden'});
  };
  await choose('深色');
  await page.reload();
  ensure(await page.locator('html').getAttribute('class').then(value=>value.includes('dark')), 'Manual mode did not persist');
  await choose('跟随系统');
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
  const other = await page.context().newPage();
  await other.goto(base + '/');
  await other.evaluate(()=>localStorage.setItem('mcnskin-theme','light'));
  await page.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
  await other.close();
  await page.goto(base + '/admin/settings#appearance');
  const form = page.locator('[data-appearance-form]');
  const baseline = await form.evaluate(element=>Object.fromEntries(new FormData(element)));
  try {
    await page.getByRole('button',{name:'紫罗兰',exact:true}).click();
    await form.locator('[name="home_layout"][value="classic"]').check();
    await form.getByRole('button',{name:'保存外观与首页',exact:true}).click();
    await page.waitForURL('**/admin/settings?saved=1#appearance');
    ensure(await form.locator('[name="theme_primary"]').inputValue()==='#7847bf','Saved palette did not persist');
    await page.goto(base + '/');
    ensure(await page.locator('body').getAttribute('class').then(value=>value.includes('home-classic')), 'Saved homepage did not persist');
    ensure(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())==='#7847bf','Saved theme not applied');
    for (const layout of ['split','classic','gallery','minimal']) {
      await page.goto(base + '/?layout_preview=' + layout);
      await page.screenshot({path:'output/playwright/home-' + layout + '.png',fullPage:true});
      await page.setViewportSize({width:390,height:844});
      ensure(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow: '+layout);
      await page.screenshot({path:'output/playwright/home-' + layout + '-mobile.png',fullPage:true});
      await page.setViewportSize({width:1440,height:1000});
    }
  } finally {
    await page.request.post(base + '/admin/settings', {form:baseline});
  }
  await page.goto(base + '/admin/settings#appearance');
  await page.screenshot({path:'output/playwright/appearance-settings.png',fullPage:true});
  ensure(await page.locator('.sidebar-nav .nav-item svg.xicon').count()>=8,'Navigation icons missing');
  await choose('跟随系统');
  await page.emulateMedia({colorScheme:'light'});
  return {earlySystemTheme:true,systemChanges:true,manualPersistence:true,crossTab:true,layouts:4,mobileWidth:390,paletteSave:true};
}
