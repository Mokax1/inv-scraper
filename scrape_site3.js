const { chromium } = require('playwright');
const xlsx = require('xlsx');

(async () => {
  console.log('Launching browser with smuggled Microsoft session...');
  const browser = await chromium.launch();
  
  const context = await browser.newContext({ storageState: 'auth_state.json' });
  const page = await context.newPage();

  console.log('Infiltrating Arvedi AST...');
  await page.goto(
  'https://excess.acciaiterni.it/cambiaFunzioneUtenteAttiva?funzioneUtenteAttiva=1',
  { waitUntil: 'networkidle' }
);

console.log("Current URL:", page.url());

// Save a screenshot of whatever GitHub actually sees
await page.screenshot({
  path: "debug.png",
  fullPage: true
});

// Save the HTML too
const fs = require("fs");
fs.writeFileSync("page.html", await page.content());

console.log("Waiting for table...");

await page.waitForSelector('#idTabella tbody tr', {
  timeout: 30000
});

  // --- NEW OPTIMIZATION STEP ---
  console.log('Optimizing pagination: Switching to 100 entries per page...');
  // DataTables universally puts the select dropdown inside a div with the ID {tableId}_length
  await page.selectOption('#idTabella_length select', '100');
  
  // Give the table 3 seconds to fetch and render the 100 rows before we start scraping
  await page.waitForTimeout(3000); 
  // -----------------------------

  console.log('Extracting data across all pages...');
  
  let allScrapedData = [];
  let pageNumber = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    console.log(`Scraping page ${pageNumber}...`);

    const pageData = await page.$$eval('#idTabella tbody tr', rows => {
      return rows.map(row => {
        const columns = row.querySelectorAll('td');
        
        if (columns.length > 10) {
          return {
            Coil: columns[1]?.innerText.trim() || '',
            KG: columns[2]?.innerText.trim() || '',
            SteelGrade: columns[3]?.innerText.trim() || '',
            Thick: columns[4]?.innerText.trim() || '',
            Width: columns[5]?.innerText.trim() || '',
            Length: columns[6]?.innerText.trim() || '',
            Shape: columns[7]?.innerText.trim() || '',
            Finish: columns[10]?.innerText.trim() || '',
            Price: columns[12]?.innerText.trim() || ''
          };
        }
        return null;
      }).filter(item => item !== null); 
    });

    allScrapedData.push(...pageData);

    const nextButton = await page.$('#idTabella_next');

    if (nextButton) {
      const isDisabled = await page.evaluate(btn => btn.classList.contains('disabled') || btn.hasAttribute('disabled'), nextButton);

      if (!isDisabled) {
        await nextButton.click();
        pageNumber++;
        await page.waitForTimeout(3000); 
      } else {
        console.log('Next button is disabled. Reached the end.');
        hasNextPage = false;
      }
    } else {
      hasNextPage = false;
    }
  }

  console.log(`Successfully scraped ${allScrapedData.length} Arvedi AST items.`);

  console.log('Generating Excel File...');
  const worksheet = xlsx.utils.json_to_sheet(allScrapedData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Arvedi AST');

  xlsx.writeFile(workbook, 'arvedi_data.xlsx');
  console.log('Excel file saved: arvedi_data.xlsx');

  await browser.close();
})();
