async page => {
  await page.screenshot({path:'output/playwright/viewer-overflow.png',fullPage:true});
  return await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,16).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,style:e.getAttribute('style')})));
}
