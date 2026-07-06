const { chromium } = require('playwright');
const path = require('path');

(async () => {
    console.log('Launching browser for direct extraction...');
    const browser = await chromium.launch({ headless: true });
    
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        timezoneId: 'Europe/Paris',
        locale: 'en-GB'
    });
    const page = await context.newPage();

    try {
        console.log('Opening Outokumpu...');
        await page.goto('https://excess-webshop.outokumpu.com/ccrz__CCSiteLogin', { waitUntil: 'networkidle' });

        console.log('Logging in...');
        await page.getByRole('textbox', { name: /username/i }).fill(process.env.OUTOKUMPU_USER);
        await page.getByRole('textbox', { name: /password/i }).fill(process.env.OUTOKUMPU_PASS);
        await page.getByRole('button', { name: /^login$/i }).click();

        console.log('Waiting 10 seconds for the backend to process login...');
        await page.waitForTimeout(10000); 

        console.log('Navigating to Excess Stock tab...');
        await page.getByRole('link', { name: 'Excess Stock', exact: true }).click();
        
        console.log('Waiting 5 seconds for the Excess Stock list to load...');
        await page.waitForTimeout(5000);

        // --- THE GATEKEEPER LOOP ---
        console.log('Checking if Outokumpu stock is live or updating...');
        let stockReady = false;
        let attempts = 0;
        const maxAttempts = 24; 

        while (!stockReady && attempts < maxAttempts) {
            const isUpdating = await page.evaluate(() => {
                return document.body.innerText.includes('We are currently updating our stock');
            });

            if (isUpdating) {
                attempts++;
                console.log(`[Attempt ${attempts}] The boss is updating stock. Sleeping for 5 minutes...`);
                await page.waitForTimeout(5 * 60 * 1000); 
                
                console.log('Refreshing page to check again...');
                await page.reload({ waitUntil: 'networkidle' });
                
                try {
                    await page.getByRole('link', { name: 'Excess Stock', exact: true }).click({ timeout: 5000 });
                } catch (e) {
                    // Ignore if already on the page
                }
                await page.waitForTimeout(5000); 
            } else {
                console.log('Stock is live! Opening the gates...');
                stockReady = true;
            }
        }

        if (!stockReady) {
            console.error('Fatal: Outokumpu never published their stock after 2 hours. Aborting the entire workflow.');
            process.exit(1);
        }
        // ---------------------------

        console.log('Waiting for the download button to be visible...');
        const downloadButtonSelector = 'button.otk-download';
        await page.waitForSelector(downloadButtonSelector, { timeout: 60000 });

        console.log('Clicking download and waiting for Salesforce to generate the file...');
        
        // Promise.all ensures we start listening BEFORE clicking.
        // Bumping the timeout to 60 seconds so Salesforce has plenty of time to process.
        const [ download ] = await Promise.all([
            page.waitForEvent('download', { timeout: 60000 }),
            page.click(downloadButtonSelector)
        ]);

        // Hardcoding the name so Retool can find it in the webhook payload
        const downloadPath = path.join(__dirname, 'outokumpu_data.xlsx');
        
        console.log(`Salesforce pushed the file. Saving to disk...`);
        
        // saveAs() automatically waits for the 5+ second download to completely finish
        await download.saveAs(downloadPath);

        console.log(`Success! File fully downloaded and saved as ${downloadPath}`);

    } catch (error) {
        console.error('Script failed. Saving screenshot...');
        await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
        process.exit(1); 
    } finally {
        await browser.close();
    }
})();
