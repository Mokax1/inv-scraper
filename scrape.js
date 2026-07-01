const { chromium } = require('playwright');
const xlsx = require('xlsx');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 1. Go to your target website
  console.log('Navigating...');
  await page.goto('https://quotes.toscrape.com/'); // Using a demo site for testing

  // 2. Extract data (Change these selectors later for your real target site)
  const scrapedData = await page.$$eval('.quote', elements => {
    return elements.map(el => ({
      Quote: el.querySelector('.text')?.innerText.trim() || '',
      Author: el.querySelector('.author')?.innerText.trim() || ''
    }));
  });

  console.log(`Successfully scraped ${scrapedData.length} rows.`);

  // 3. Generate Excel File
  const worksheet = xlsx.utils.json_to_sheet(scrapedData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Scraped Data');

  // 4. Save file locally
  xlsx.writeFile(workbook, 'scraped_data.xlsx');
  console.log('Excel file saved: scraped_data.xlsx');

  await browser.close();
})();