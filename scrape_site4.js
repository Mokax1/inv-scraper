const { chromium } = require('playwright');
const xlsx = require('xlsx');

(async () => {
    console.log('Launching browser for direct extraction...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        timezoneId: 'Europe/Paris' // Forces the bot's clock to CET
    });
    const page = await context.newPage();

    try {
        console.log('Opening Outokumpu...');
        await page.goto('https://excess-webshop.outokumpu.com/ccrz__CCSiteLogin?startURL=%2Fccrz__ProductList', { waitUntil: 'networkidle' });

        console.log('Logging in...');
        await page.getByRole('textbox', { name: /username/i }).fill(process.env.OUTOKUMPU_USER);
        await page.getByRole('textbox', { name: /password/i }).fill(process.env.OUTOKUMPU_PASS);
        await page.getByRole('button', { name: /^login$/i }).click();

        // THE FIX: Wait 10 full seconds for Salesforce to finish its redirects and render the dashboard
        console.log('Waiting 10 seconds for the dashboard to render...');
        await page.waitForTimeout(10000); 

        // --- THE GATEKEEPER LOOP ---
        console.log('Checking if Outokumpu stock is live or updating...');
        let stockReady = false;
        let attempts = 0;
        const maxAttempts = 24; // Will wait a maximum of 2 hours (24 * 5 mins) before giving up

        while (!stockReady && attempts < maxAttempts) {
            const isUpdating = await page.evaluate(() => {
                return document.body.innerText.includes('We are currently updating our stock');
            });

            if (isUpdating) {
                console.log('Bot thinks it is updating! Taking a snapshot and aborting so we can see the ghost...');
                // Snap a picture right this second
                await page.screenshot({ path: 'loop_ghost.png', fullPage: true });
                // Instantly crash the script to bypass the sleep timer
                process.exit(0); 
            } else {
                console.log('Stock is live! Opening the gates...');
                stockReady = true;
            }
        }

        if (!stockReady) {
            console.error('Fatal: Outokumpu never published their stock after 2 hours. Aborting the entire workflow.');
            process.exit(1); // Exits with an error code so the other scrapers DO NOT run
        }
        // ---------------------------

        console.log('Waiting for the data list to load...');
        await page.waitForSelector('div.cc_product_item', { timeout: 60000 });

        console.log('Setting list results to 75 items per page...');
        try {
            const selects = await page.$$('select');
            for (const select of selects) {
                const innerText = await select.innerText();
                if (innerText.includes('75')) {
                    await select.selectOption({ label: '75' }).catch(() => select.selectOption({ value: '75' }));
                    await page.waitForTimeout(4000); 
                    break;
                }
            }
        } catch (e) {
            console.log('Could not automatically set to 75, proceeding with default loop...');
        }

        console.log('Expanding all products (Clicking "Show Next" until the end)...');
        let hasMore = true;
        while (hasMore) {
            const loadMoreBtn = await page.$('button.cc_show_more');
            if (loadMoreBtn) {
                const isVisible = await loadMoreBtn.isVisible();
                if (isVisible) {
                    console.log('Clicking "Show Next Results"...');
                    await loadMoreBtn.click();
                    await page.waitForTimeout(3000); 
                } else {
                    hasMore = false; 
                }
            } else {
                hasMore = false; 
            }
        }
        
        console.log('All products loaded on the page. Extracting data...');

        const allScrapedData = await page.$$eval('div.cc_product_item', rows => {
            return rows.map(row => {
                const textBlocks = row.innerText.split('\n').map(t => t.trim()).filter(t => t !== '');
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
        process.exit(1); 
    } finally {
        await browser.close();
    }
})();
