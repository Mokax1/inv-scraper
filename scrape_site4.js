const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {

    console.log('Launching browser...');

    const browser = await chromium.launch({
        headless: true
    });

    const context = await browser.newContext();

    // Install hooks BEFORE any website JavaScript runs
    await context.addInitScript(() => {

        window.__capturedBlob = null;
        window.__capturedDownloadHref = null;

        const originalCreateObjectURL = URL.createObjectURL;

        URL.createObjectURL = function(blob) {
            window.__capturedBlob = blob;
            return originalCreateObjectURL.call(this, blob);
        };

        const originalClick = HTMLAnchorElement.prototype.click;

        HTMLAnchorElement.prototype.click = function() {

            if (this.download || (this.href && this.href.startsWith('blob:'))) {
                window.__capturedDownloadHref = this.href;
            }

            return originalClick.call(this);
        };

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

    await page.waitForSelector('button.otk-download', {
        timeout: 60000
    });

    console.log('Clicking Download Product List...');

    await page.locator('button.otk-download').click();

    console.log('Waiting for Excel blob...');

    await page.waitForFunction(() => window.__capturedBlob !== null, {
        timeout: 60000
    });

    console.log('Blob captured.');

    const base64 = await page.evaluate(async () => {

        const blob = window.__capturedBlob;

        const buffer = await blob.arrayBuffer();

        let binary = '';

        const bytes = new Uint8Array(buffer);

        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }

        return btoa(binary);

    });

    const outputPath = path.join(process.cwd(), 'outokumpu_data.xlsx');

    fs.writeFileSync(
        outputPath,
        Buffer.from(base64, 'base64')
    );

    console.log('Excel saved successfully:', outputPath);

    await browser.close();

})();
