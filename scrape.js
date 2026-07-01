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
  await page.getByRole('textbox', { name: 'Username' }).fill(process.env.HEGO_USER);
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.HEGO_PASS);
  await page.getByRole('button', { name: 'Log In' }).click();

  console.log('Navigating to Excess Stock...');
  await page.getByRole('link', { name: 'Excess Stock' }).click();

  console.log('Waiting for initial data to load...');
  await page.waitForSelector('c-esh_lwc_search-product-card', { timeout: 30000 });

  console.log('Extracting list data across all pages...');
  
  // Create a master array to hold data from all pages
  let allScrapedData = [];
  let pageNumber = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    console.log(`Scraping page ${pageNumber}...`);

    // 1. Extract data on the current page
    const pageData = await page.$$eval('c-esh_lwc_search-product-card', elements => {
      return elements.map(el => {
        const rawTitle = el.querySelector('.name-field-line')?.innerText.trim() || '';
        const allText = el.innerText.trim();
        return { Product: rawTitle, FullDetails: allText };
      });
    });

    // Add this page's data to our master list
    allScrapedData.push(...pageData);

    // 2. Look for the "Next" button using the exact selector we found
    const nextButton = await page.$('button.nav-direction:has-text("Next")'); 

    if (nextButton) {
      // Check if we hit the end (Salesforce adds a 'disabled' attribute to the button on the last page)
      const isDisabled = await page.evaluate(btn => btn.hasAttribute('disabled') || btn.disabled, nextButton);

      if (!isDisabled) {
        console.log('Clicking Next page...');
        await nextButton.click();
        pageNumber++;

        // Wait 4 seconds for Salesforce to load the new data before the loop repeats
        await page.waitForTimeout(4000); 
      } else {
        console.log('Next button is disabled. Reached the end of the list.');
        hasNextPage = false;
      }
    } else {
      console.log('No Next button found on the page. Reached the end.');
      hasNextPage = false;
    }
  }

  console.log(`Successfully scraped a total of ${allScrapedData.length} items.`);

  console.log('Generating Excel File...');
  const worksheet = xlsx.utils.json_to_sheet(allScrapedData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Excess Stock');

  xlsx.writeFile(workbook, 'scraped_data.xlsx');
  console.log('Excel file saved: scraped_data.xlsx');

  await browser.close();
})();
