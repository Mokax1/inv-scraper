const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  // 1. Load the authenticated session (Bypasses 2FA/Email Verification)
  const stateData = JSON.parse(process.env.APERAM_AUTH_STATE);
  fs.writeFileSync('state.json', JSON.stringify(stateData));

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: 'state.json' });
  const page = await context.newPage();

  console.log("Navigating directly to Aperam Special Offers...");
  await page.goto('https://www.e-aperam.com/flash-sales/special-offer');
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  // Take a "Proof of Life" screenshot right as it loads
  await page.screenshot({ path: '1-initial-load.png', fullPage: true });
  console.log("CURRENT URL: ", page.url());

  // 2. Forced Login Check
  console.log("Looking for login fields...");
  const emailInput = page.locator('input[type="email"], input[name*="email" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  try {
    // Wait up to 10 seconds specifically for the email field to appear
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    console.log("Login screen detected. Injecting credentials...");
    
    await emailInput.fill(process.env.APERAM_EMAIL);
    await passwordInput.fill(process.env.APERAM_PASSWORD);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      passwordInput.press('Enter')
    ]);
    
    console.log("Logged in successfully. CURRENT URL: ", page.url());
    await page.screenshot({ path: '2-post-login.png', fullPage: true });

    // Force navigate to special offers if the login dumped us on the main dashboard
    if (!page.url().includes('flash-sales/special-offer')) {
      console.log("Redirecting back to Special Offers...");
      await page.goto('https://www.e-aperam.com/flash-sales/special-offer');
      await page.waitForLoadState('networkidle');
    }
  } catch (e) {
    console.log("No email input found within 10 seconds. Assuming we are already in or blocked by a popup.");
  }

  // 3. Sweeper & Export
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
      // Ignore
    }
  }

  console.log("Hunting for the EXPORT ALL button...");
  try {
    const exportBtn = page.getByRole('button', { name: /EXPORT ALL/i });
    await exportBtn.waitFor({ state: 'visible', timeout: 15000 });
    
    console.log("Downloading export...");
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      exportBtn.click()
    ]);

    const downloadPath = path.join(__dirname, 'aperam_export.xlsx');
    await download.saveAs(downloadPath);
    console.log(`Saved successfully to ${downloadPath}`);

  } catch (error) {
    console.log("Failed to find or click EXPORT ALL! Taking a debug screenshot...");
    await page.screenshot({ path: '3-crash-debug.png', fullPage: true });
    throw error;
  }

  await browser.close();
})();
