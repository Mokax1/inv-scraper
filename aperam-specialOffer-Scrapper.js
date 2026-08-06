const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  // 1. Load the authenticated session
  const stateData = JSON.parse(process.env.APERAM_AUTH_STATE);
  fs.writeFileSync('state.json', JSON.stringify(stateData));

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: 'state.json' });
  const page = await context.newPage();

  console.log("Navigating directly to Aperam Special Offers...");
  await page.goto('https://www.e-aperam.com/flash-sales/special-offer');
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  console.log("CURRENT URL: ", page.url());
  await page.screenshot({ path: '1-initial-load.png', fullPage: true });

  // 2. Forced Login Check (If session expired or not logged in)
  const emailInput = page.locator('input[type="text"].mat-mdc-input-element, input[type="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  try {
    console.log("Looking for login fields...");
    await emailInput.waitFor({ state: 'visible', timeout: 5000 });
    console.log("Login screen detected. Injecting credentials...");
    
    await emailInput.fill(process.env.APERAM_EMAIL);
    await passwordInput.fill(process.env.APERAM_PASSWORD);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      passwordInput.press('Enter')
    ]);
    
    console.log("Logged in successfully. CURRENT URL: ", page.url());

    if (!page.url().includes('flash-sales/special-offer')) {
      console.log("Letting auth cookies settle...");
      await page.waitForTimeout(3000);
      console.log("Redirecting back to Special Offers...");
      await page.goto('https://www.e-aperam.com/flash-sales/special-offer');
    }
  } catch (e) {
    console.log("No login input found. Proceeding with stored auth state...");
  }

  // --- Global wait for Angular/API response ---
  console.log("Waiting for Angular API to fetch data...");
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000); // Wait for API table rendering

  await page.screenshot({ path: '2-post-login-state.png', fullPage: true });

  // 3. Sweeper
  console.log("Sweeping for cookie banners and news pop-ups...");
  const interceptors = [
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button:has-text("Dismiss")',
    '[aria-label="Close"]',
    '[aria-label="close"]',
    '.modal-close',
    '.close-button'
  ];

  for (const selector of interceptors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        console.log(`Found a blocker! Dismissing using: ${selector}`);
        await btn.click({ force: true });
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      // Ignore missing popups
    }
  }

  await page.screenshot({ path: '3-post-sweep-state.png', fullPage: true });

  // 4. Export
  console.log("Hunting for the EXPORT ALL button...");
  try {
    const exportBtn = page.getByRole('button', { name: /EXPORT ALL/i });
    await exportBtn.waitFor({ state: 'visible', timeout: 20000 });
    
    console.log("Downloading export...");
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      exportBtn.click()
    ]);

    const downloadPath = path.join(__dirname, 'aperam_export.xlsx');
    await download.saveAs(downloadPath);
    console.log(`Saved successfully to ${downloadPath}`);

  } catch (error) {
    console.log("Failed to find or click EXPORT ALL! Taking a crash debug screenshot...");
    await page.screenshot({ path: '4-crash-debug.png', fullPage: true });
    throw error;
  }

  await browser.close();
})();
