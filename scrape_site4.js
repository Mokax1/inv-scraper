const { chromium } = require('playwright');
const path = require('path');

(async () => {

    console.log('Launching browser...');

    const browser = await chromium.launch({
        headless: true
    });

    const context = await browser.newContext({
        acceptDownloads: true
    });

    const page = await context.newPage();

    console.log('Opening Outokumpu...');

    await page.goto(
        'https://excess-webshop.outokumpu.com/ccrz__CCSiteLogin?startURL=%2Fccrz__ProductList',
        {
            waitUntil: 'networkidle'
        }
    );

    console.log('Logging in...');

    await page.getByRole('textbox', {
        name: /username/i
    }).fill(process.env.OUTOKUMPU_USER);

    await page.getByRole('textbox', {
        name: /password/i
    }).fill(process.env.OUTOKUMPU_PASS);

    await page.getByRole('button', {
        name: /^login$/i
    }).click();

    console.log('Waiting for product page...');

    await page.waitForLoadState('networkidle');

    console.log('Downloading product list...');

    const downloadPromise = page.waitForEvent('download');

    await page.getByRole('button', {
        name: /download.*product.*list/i
    }).click();

    const download = await downloadPromise;

    const outputPath = path.join(process.cwd(), 'outokumpu_data.xlsx');

    await download.saveAs(outputPath);

    console.log('Download complete.');

    await browser.close();

})();
