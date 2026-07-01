const { chromium } = require('playwright');
const path = require('path');

(async () => {
    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: true });
    
    // acceptDownloads is crucial here
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

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
    // Wait for the specific download button to appear on the screen
    await page.waitForSelector('button.otk-download', { timeout: 60000 });

    console.log('Clicking Download Product List and intercepting file...');

    // The Magic Playwright Way: This catches both server downloads and in-memory blobs
    try {
        const [ download ] = await Promise.all([
            page.waitForEvent('download', { timeout: 60000 }), // Listen for the download event
            page.locator('button.otk-download').click()        // Click the button
        ]);

        const outputPath = path.join(process.cwd(), 'outokumpu_data.xlsx');
        
        // Save the intercepted file directly to our folder
        await download.saveAs(outputPath);
        console.log('Excel saved successfully:', outputPath);

    } catch (error) {
        console.error('Download failed to trigger. Ensure the button selector is correct.', error);
    }

    await browser.close();
})();
