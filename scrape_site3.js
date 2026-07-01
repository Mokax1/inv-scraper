const { chromium } = require('playwright');
const xlsx = require('xlsx');
const fs = require('fs');

(async () => {

    console.log('Launching browser with saved Microsoft session...');

    const browser = await chromium.launch({
        headless: true
    });

    const context = await browser.newContext({
        storageState: 'auth_state.json'
    });

    const page = await context.newPage();

    console.log('Opening Arvedi AST...');

    await page.goto(
        'https://excess.acciaiterni.it/cambiaFunzioneUtenteAttiva?funzioneUtenteAttiva=1',
        { waitUntil: 'networkidle' }
    );

    console.log('Current URL:', page.url());

    // Debug files
    await page.screenshot({
        path: 'debug.png',
        fullPage: true
    });

    fs.writeFileSync('page.html', await page.content());

    //---------------------------------------------------
    // Accept cookie popup (only if present)
    //---------------------------------------------------

    try {

        const cookieButton = page.getByRole('button', {
            name: /save and continue/i
        });

        if (await cookieButton.isVisible({ timeout: 5000 })) {

            console.log('Accepting cookies...');

            await cookieButton.click();

            await page.waitForTimeout(1000);

        }

    } catch {

        console.log('Cookie popup not found.');

    }

    //---------------------------------------------------
    // Click ENTER under LIST OF AVAILABLE MATERIAL
    //---------------------------------------------------

    console.log('Opening available material...');

    const enterButtons = page.getByRole('button', {
        name: 'ENTER'
    });

    await enterButtons.first().click();

    //---------------------------------------------------
    // Wait for inventory table
    //---------------------------------------------------

    console.log('Waiting for inventory table...');

    await page.waitForSelector('#idTabella', {
        timeout: 30000
    });

    await page.waitForSelector('#idTabella tbody tr', {
        timeout: 30000
    });

    //---------------------------------------------------
    // Change page size
    //---------------------------------------------------

    console.log('Changing table to 100 rows...');

    await page.waitForSelector('#idTabella_length select');

    await page.selectOption('#idTabella_length select', '100');

    await page.waitForFunction(() => {

        return document.querySelectorAll('#idTabella tbody tr').length > 50;

    });

    console.log('100-row table loaded.');

    //---------------------------------------------------
    // Begin scraping
    //---------------------------------------------------

    let allScrapedData = [];
    let pageNumber = 1;
    let hasNextPage = true;

    while (hasNextPage) {

        console.log(`Scraping page ${pageNumber}...`);

        const pageData = await page.$$eval('#idTabella tbody tr', rows => {

            return rows.map(row => {

                const columns = row.querySelectorAll('td');

                if (columns.length > 12) {

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

            }).filter(Boolean);

        });

        allScrapedData.push(...pageData);

        console.log(`Collected ${allScrapedData.length} rows so far.`);

        const nextButton = page.locator('#idTabella_next');

        const disabled = await nextButton.evaluate(el =>
            el.classList.contains('disabled')
        );

        if (disabled) {

            console.log('Reached last page.');

            hasNextPage = false;

        } else {

            console.log(`Going to page ${pageNumber + 1}...`);

            await Promise.all([

                nextButton.click(),

                page.waitForFunction(() => {

                    const processing = document.querySelector('#idTabella_processing');

                    return !processing || processing.style.display === 'none';

                })

            ]);

            pageNumber++;

        }

    }

    //---------------------------------------------------
    // Export Excel
    //---------------------------------------------------

    console.log(`Finished! Total rows: ${allScrapedData.length}`);

    const worksheet = xlsx.utils.json_to_sheet(allScrapedData);

    const workbook = xlsx.utils.book_new();

    xlsx.utils.book_append_sheet(workbook, worksheet, 'Arvedi AST');

    xlsx.writeFile(workbook, 'arvedi_data.xlsx');

    console.log(`Excel exported with ${allScrapedData.length} rows.`);

    await browser.close();

})();
