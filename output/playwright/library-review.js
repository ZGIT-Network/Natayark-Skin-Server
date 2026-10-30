async page=>{
  const base='http://127.0.0.1:3000';
  const imagesReady=()=>page.waitForFunction(()=>[...document.querySelectorAll('.library-card:nth-child(-n+4) .library-preview img')].every(img=>img.complete&&img.naturalWidth>0));
  await page.setViewportSize({width:1440,height:1000});
  for(const [route,name] of [['/skinlib','skinlib-cards'],['/admin/textures','admin-texture-cards']]) {
    await page.goto(base+route);
    await imagesReady();
    const columns=await page.locator('.library-grid').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length);
    if(columns!==4)throw new Error('Expected four desktop columns, got '+columns);
    const oversized=await page.locator('.library-preview').evaluateAll(elements=>elements.some(e=>e.getBoundingClientRect().height>400));
    if(oversized)throw new Error('Oversized preview');
    await page.screenshot({path:'output/playwright/'+name+'.png',fullPage:false});
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.querySelector('[data-sidebar]').getBoundingClientRect().right<=0);
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Library mobile overflow');
    await page.screenshot({path:'output/playwright/'+name+'-mobile.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('link',{name:'最多收藏',exact:true}).click();
    await page.waitForURL('**sort=likes*');
    await page.getByRole('link',{name:'清除筛选',exact:true}).click();
    await page.waitForURL('**'+route);
  }
  return{columns:4,largePreviewsBounded:true,publicAndAdmin:true,mobileWidth:390,sortAndReset:true};
}
