const { chromium } = require('playwright');
const xlsx = require('xlsx');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  
  // 1. Added the stealthy user agent to prevent bot-blocks during load
  const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
      console.log('Navigating to Acerinox Direct...');
      
      // 2 & 3. Increased timeout and changed waitUntil to be less strict
      await page.goto('https://www.acerinoxdirect.com/', { 
          timeout: 60000, 
          waitUntil: 'domcontentloaded' 
      });

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
      await page.waitForSelector('c-esh_lwc_search-product-card', { timeout: 60000 });

      console.log('Extracting list data across all pages...');
      
      let allScrapedData = [];
      let pageNumber = 1;
      let hasNextPage = true;

      while (hasNextPage) {
        console.log(`Scraping page ${pageNumber}...`);

        const pageData = await page.$$eval('c-esh_lwc_search-product-card', elements => {
          return elements.map(el => {
            const rawTitle = el.querySelector('.name-field-line')?.innerText.trim() || '';
            
            // --- ADDED PRICE EXTRACTION HERE ---
            // Targeting the stable classes and ignoring the dynamic 'lwc-' prefix
            const rawPrice = el.querySelector('.uom-price.price-label')?.innerText.trim() || 'N/A';
            
            const allText = el.innerText.trim();
            
            return { 
              Product: rawTitle, 
              Price: rawPrice, 
              FullDetails: allText 
            };
          });
        });

        allScrapedData.push(...pageData);

        const nextButton = await page.$('button.nav-direction:has-text("Next")'); 

        if (nextButton) {
          const isDisabled = await page.evaluate(btn => btn.hasAttribute('disabled') || btn.disabled, nextButton);

          if (!isDisabled) {
            console.log('Clicking Next page...');
            await nextButton.click();
            pageNumber++;
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

  } catch (error) {
      // 4. Added our safety net
      console.error('Acerinox scraping failed. Taking screenshot...');
      await page.screenshot({ path: 'acerinox_error_screenshot.png', fullPage: true });
      console.error(error);
      process.exit(0);
  } finally {
      await browser.close();
  }
})();
