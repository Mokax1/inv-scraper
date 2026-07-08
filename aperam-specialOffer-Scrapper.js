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

  console.log("Navigating to Aperam...");
  // Go to the target page first
  await page.goto('https://www.e-aperam.com/flash-sales/special-offer');

  // Wait a moment for the page to decide if it wants to redirect us to login
  await page.waitForLoadState('networkidle');

  // 2. The Login Fallback Check
  // We look for standard email or password inputs that might indicate a login screen
  const emailInput = page.locator('input[type="email"], input[name*="email" i]');
  const passwordInput = page.locator('input[type="password"]');

  // If the email field is visible, the session wasn't enough on its own
  if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("Login screen detected. Injecting credentials...");
    
    await emailInput.fill(process.env.APERAM_EMAIL);
    await passwordInput.fill(process.env.APERAM_PASSWORD);
    
    // Press enter to log in and wait for the page to navigate back to the flash sales
    await Promise.all([
      page.waitForNavigation(),
      passwordInput.press('Enter')
    ]);
    
    console.log("Logged in successfully. Continuing to target page...");
    
    // Just in case it didn't redirect us back to the exact page, let's force it
    if (!page.url().includes('flash-sales/special-offer')) {
      await page.goto('https://www.e-aperam.com/flash-sales/special-offer');
      await page.waitForLoadState('networkidle');
    }
  } else {
    console.log("Session accepted. No login screen detected.");
  }

  // 3. Execute the Export
  console.log("Waiting for the EXPORT ALL button...");
  
  // Wait a couple of seconds for dynamic tables to render
  await page.waitForTimeout(3000); 

  console.log("Downloading export...");
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /EXPORT ALL/i }).click()
  ]);

  const downloadPath = path.join(__dirname, 'aperam_export.xlsx');
  await download.saveAs(downloadPath);
  console.log(`Saved successfully to ${downloadPath}`);

  await browser.close();
})();
