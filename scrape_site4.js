const { chromium } = require('playwright');
const path = require('path');

(async () => {
    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ 
        acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        console.log('Opening Outokumpu...');
        await page.goto(
            'https://excess-webshop.outokumpu.com/ccrz__CCSiteLogin?startURL=%2Fccrz__ProductList',
            { waitUntil: 'networkidle' }
        );

        console.log('Logging in...');
        await page.getByRole('textbox', { name: /username/i }).fill(process.env.OUTOKUMPU_USER);
        await page.getByRole('textbox', { name: /password/i }).fill(process.env.OUTOKUMPU_PASS);
        await page.getByRole('button', { name: /^login$/i }).click();

        console.log('Waiting for product page...');
        // Wait for the button to actually be visible in the DOM
        await page.waitForSelector('button.otk-download', { state: 'visible', timeout: 60000 });

        console.log('Button found. Waiting 5 seconds for Salesforce Javascript to bind...');
        await page.waitForTimeout(5000); 

        console.log('Executing Javascript click to bypass invisible overlays...');
        const [ download ] = await Promise.all([
            page.waitForEvent('download', { timeout: 120000 }), 
            
            // THE FIX: Trigger the click via pure Javascript inside the browser
            page.evaluate(() => {
                document.querySelector('button.otk-download').click();
            })
        ]);

        const outputPath = path.join(process.cwd(), 'outokumpu_data.xlsx');
        
        await download.saveAs(outputPath);
        console.log('Excel saved successfully:', outputPath);

    } catch (error) {
        console.error('Download failed. Saving screenshot...');
        await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
        console.error(error);
        process.exit(0); 
    } finally {
        await browser.close();
    }
})();
