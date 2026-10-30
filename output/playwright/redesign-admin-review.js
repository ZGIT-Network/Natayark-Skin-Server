async (page) => {
  const base = 'http://127.0.0.1:3000';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/admin');
  await page.screenshot({ path: 'output/playwright/redesign-admin.png', fullPage: true });
  await page.goto(base + '/admin/settings');
  await page.getByRole('tab', { name: '积分经济', exact: true }).click();
  if (await page.getByRole('tab', { name: '积分经济', exact: true }).getAttribute('aria-selected') !== 'true') throw new Error('Tab did not activate');
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  await page.screenshot({ path: 'output/playwright/redesign-settings.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('[data-sidebar]').getBoundingClientRect().right <= 0);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Settings overflow');
  await page.screenshot({ path: 'output/playwright/redesign-settings-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/?lang=en');
  await page.getByRole('heading', { name: 'Recently uploaded', exact: true }).waitFor();
  const missingNames = await page.locator('a, button').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width && !element.textContent.trim() && !element.getAttribute('aria-label') && !element.querySelector('img, svg')).map(element => element.outerHTML));
  if (missingNames.length) throw new Error('Empty controls: ' + missingNames.join('\n'));
  return { settingsTabs: 'passed', mobileWidth: 390, emptyControls: missingNames.length };
}
