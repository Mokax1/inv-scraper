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

  console.log("Navigating to Aperam Homepage...");
  // Start at the root so the SPA routes properly
  await page.goto('https://www.e-aperam.com/');
  await page.waitForLoadState('networkidle');

  // 2. The Login Fallback Check
  const emailInput = page.locator('input[type="email"], input[name*="email" i]');
  const passwordInput = page.locator('input[type="password"]');

  if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log("Login screen detected. Injecting credentials...");
    
    await emailInput.fill(process.env.APERAM_EMAIL);
    await passwordInput.fill(process.env.APERAM_PASSWORD);
    
    await Promise.all([
      page.waitForNavigation(),
      passwordInput.press('Enter')
    ]);
    
    console.log("Logged in successfully. Waiting for dashboard to settle...");
    await page.waitForLoadState('networkidle');
  } else {
    console.log("Session accepted. No login screen detected.");
  }

  // 3. UI Navigation (The Human Way)
  console.log("Clicking through the UI menu: FLASH SALES -> Special Offers...");
  try {
    // Wait for and click FLASH SALES
    const flashSalesMenu = page.locator('text=/FLASH SALES/i').first();
    await flashSalesMenu.waitFor({ state: 'visible', timeout: 10000 });
    await flashSalesMenu.click();
    
    await page.waitForTimeout(1000); // Give the dropdown a second to animate

    // Wait for and click Special Offers
    const specialOffersMenu = page.locator('text=/Special Offer/i').first();
    await specialOffersMenu.waitFor({ state: 'visible', timeout: 5000 });
    await specialOffersMenu.click();
    
  } catch (e) {
    console.log("Failed to click menu items. Taking screenshot...");
    await page.screenshot({ path: 'aperam-menu-crash.png', fullPage: true });
    throw e;
  }

  // 4. Aggressive Sweeper & Export
  console.log("Waiting for special offers data to load...");
  await page.waitForLoadState('networkidle', { timeout: 15000 });

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

  // Rapidly check if any of these exist and click them if they do
  for (const selector of interceptors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        console.log(`Found a blocker! Dismissing using: ${selector}`);
        await btn.click({ force: true });
        await page.waitForTimeout(1000); // Give the modal a second to fade out
      }
    } catch (e) {
      // Silently ignore if this specific button isn't found
    }
  }

  console.log("Hunting for the EXPORT ALL button...");
  try {
    const exportBtn = page.getByRole('button', { name: /EXPORT ALL/i });
    // Explicitly wait for the button to become visible and clickable
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
    await page.screenshot({ path: 'aperam-crash-debug.png', fullPage: true });
    
    // Re-throw so the action still correctly fails
    throw error;
  }

  await browser.close();
})();
