const { chromium } = require('playwright');
const xlsx = require('xlsx');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigating to Acerinox Direct...');
  await page.goto('https://www.acerinoxdirect.com/');

  console.log('Logging in...');
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.getByRole('textbox', { name: 'Username' }).click();
  
  // Using secure environment variables instead of hardcoded credentials
  await page.getByRole('textbox', { name: 'Username' }).fill(process.env.HEGO_USER);
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.HEGO_PASS);
  
  await page.getByRole('button', { name: 'Log In' }).click();

  console.log('Navigating to Excess Stock...');
  await page.getByRole('link', { name: 'Excess Stock' }).click();

  console.log('Waiting for Salesforce Lightning components to load...');
  // This forces Playwright to pause and wait until the list actually appears on screen
  await page.waitForSelector('c-esh_lwc_search-product-card', { timeout: 30000 });

  console.log('Extracting list data...');
  const scrapedData = await page.$$eval('c-esh_lwc_search-product-card', elements => {
    return elements.map(el => {
      const rawTitle = el.querySelector('.name-field-line')?.innerText.trim() || '';
      const allText = el.innerText.trim();

      return {
        Product: rawTitle,
        FullDetails: allText 
      };
    });
  });

  console.log(`Successfully scraped ${scrapedData.length} rows.`);

  console.log('Generating Excel File...');
  const worksheet = xlsx.utils.json_to_sheet(scrapedData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Excess Stock');

  xlsx.writeFile(workbook, 'scraped_data.xlsx');
  console.log('Excel file saved: scraped_data.xlsx');

  await browser.close();
})();
