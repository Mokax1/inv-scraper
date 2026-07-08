const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  // Load the authenticated session from the GitHub environment variable
  const stateData = JSON.parse(process.env.APERAM_AUTH_STATE);
  fs.writeFileSync('state.json', JSON.stringify(stateData));

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: 'state.json' });
  const page = await context.newPage();

  console.log("Navigating to flash sales...");
  await page.goto('https://www.e-aperam.com/flash-sales/special-offer');

  // Wait a couple of seconds for the table/button to load
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
