const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  const targetUrl = 'https://tdsm.app/CentralizeAdmin/Login/Login?encId=PorpdwJMjHo_EQUAL_';

  // Navigate and wait for network activity to settle
  await page.goto(targetUrl, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  // Brief grace period for any dynamic JS rendering
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'screenshot.png', fullPage: true });
  await browser.close();
})();
