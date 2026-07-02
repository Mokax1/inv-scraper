const { chromium } = require('playwright');
const xlsx = require('xlsx');

(async () => {
    console.log('Launching browser for direct extraction...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        timezoneId: 'Europe/Paris'
    });
    const page = await context.newPage();

    try {
        console.log('Opening Outokumpu...');
        await page.goto('https://excess-webshop.outokumpu.com/ccrz__CCSiteLogin?startURL=%2Fccrz__ProductList', { waitUntil: 'networkidle' });

        console.log('Logging in...');
        await page.getByRole('textbox', { name: /username/i }).fill(process.env.OUTOKUMPU_USER);
        await page.getByRole('textbox', { name: /password/i }).fill(process.env.OUTOKUMPU_PASS);
        await page.getByRole('button', { name: /^login$/i }).click();

        console.log('Waiting for the data list to load...');
        // Using the row wrapper class from your screenshot
        await page.waitForSelector('div.cc_product_item', { timeout: 60000 });

        console.log('Setting list results to 75 items per page...');
        try {
            // Find the dropdown that controls page size and set it to 75
            const selects = await page.$$('select');
            for (const select of selects) {
                const innerText = await select.innerText();
                if (innerText.includes('75')) {
                    await select.selectOption({ label: '75' }).catch(() => select.selectOption({ value: '75' }));
                    // Wait for the page to refresh with the 75 items
                    await page.waitForTimeout(4000); 
                    break;
                }
            }
        } catch (e) {
            console.log('Could not automatically set to 75, proceeding with default "Show More" loop...');
        }

        console.log('Expanding all products (Clicking "Show Next" until the end)...');
        let hasMore = true;
        while (hasMore) {
            // Using the exact button class from your second screenshot
            const loadMoreBtn = await page.$('button.cc_show_more');
            
            if (loadMoreBtn) {
                const isVisible = await loadMoreBtn.isVisible();
                if (isVisible) {
                    console.log('Clicking "Show Next Results"...');
                    await loadMoreBtn.click();
                    // Give Salesforce 3 seconds to fetch and render the next batch of items
                    await page.waitForTimeout(3000); 
                } else {
                    hasMore = false; // Button is hidden, we reached the end
                }
            } else {
                hasMore = false; // Button no longer exists
            }
        }
        
        console.log('All products loaded on the page. Extracting data...');

        // Extracting all rows at once since it's an infinite-scroll style page
        const allScrapedData = await page.$$eval('div.cc_product_item', rows => {
            return rows.map(row => {
                // Because this is a div-based grid, we can grab the text of the entire row
                // and split it by newlines to automatically separate the columns
                const textBlocks = row.innerText.split('\n').map(t => t.trim()).filter(t => t !== '');
                
                // Safety check: ensure we have enough data points (ignoring empty/header rows)
                if (textBlocks.length >= 10) {
                    return {
                        PackageId: textBlocks[0] || '',
                        ProductType: textBlocks[1] || '',
                        ENGrade: textBlocks[2] || '',
                        Quality: textBlocks[3] || '',
                        Thickness: textBlocks[4] || '',
                        Width: textBlocks[5] || '',
                        Length: textBlocks[6] || '',
                        ENFinish: textBlocks[7] || '',
                        Weight: textBlocks[8] || '',
                        Pieces: textBlocks[9] || '',
                        Price: textBlocks[10] || ''
                    };
                }
                return null;
            }).filter(item => item !== null); 
        });

        console.log(`Successfully scraped ${allScrapedData.length} Outokumpu items.`);

        console.log('Generating Excel File...');
        const worksheet = xlsx.utils.json_to_sheet(allScrapedData);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Outokumpu Data');

        xlsx.writeFile(workbook, 'outokumpu_data.xlsx');
        console.log('Excel file saved: outokumpu_data.xlsx');

    } catch (error) {
        console.error('Scraping failed. Saving screenshot...');
        await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
        process.exit(0);
    } finally {
        await browser.close();
    }
})();
