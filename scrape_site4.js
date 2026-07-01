const { chromium } = require('playwright');
const path = require('path');

(async () => {
    console.log('Launching browser...');
    // Added a realistic user agent to prevent bot-blocking
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
        await page.waitForSelector('button.otk-download', { timeout: 60000 });

        // FIX 1: Wait 5 seconds after the button appears to ensure the site's JavaScript is fully loaded
        console.log('Button found. Waiting 5 seconds for site scripts to stabilize...');
        await page.waitForTimeout(5000); 

        console.log('Clicking Download Product List and intercepting file...');

        const [ download ] = await Promise.all([
            // FIX 2: Increased timeout to 120 seconds in case the server is just slow at generating the file
            page.waitForEvent('download', { timeout: 120000 }), 
            
            // FIX 3: Added { force: true } to bypass any invisible popups or overlays blocking the click
            page.locator('button.otk-download').click({ force: true }) 
        ]);

        const outputPath = path.join(process.cwd(), 'outokumpu_data.xlsx');
        
        await download.saveAs(outputPath);
        console.log('Excel saved successfully:', outputPath);

    } catch (error) {
        // If it fails again, this will take a picture of exactly what the bot is looking at!
        console.error('Download failed. Taking a debug screenshot...');
        await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
        console.error(error);
        process.exit(1); 
    } finally {
        await browser.close();
    }
})();
