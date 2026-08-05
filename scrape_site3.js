const { chromium } = require('playwright');
const xlsx = require('xlsx');
const fs = require('fs');

(async () => {
    let browser;

    try {
        console.log('Launching browser...');

        browser = await chromium.launch({
            headless: true
        });

        const context = await browser.newContext({
            storageState: 'auth_state.json'
        });

        const page = await context.newPage();

        //----------------------------------------------------
        // Open session
        //----------------------------------------------------

        console.log('Opening Microsoft session...');

        await page.goto(
            'https://excess.acciaiterni.it/oauth_login_success',
            { waitUntil: 'networkidle' }
        );

        console.log('Current URL:', page.url());

        //----------------------------------------------------
        // Cookies
        //----------------------------------------------------

        try {
            const cookieButton = page.getByRole('button', {
                name: /save and continue/i
            });

            if (await cookieButton.isVisible({ timeout: 5000 })) {
                console.log('Accepting cookies...');
                await cookieButton.click();
            }
        } catch {
            console.log('No cookie popup.');
        }

        //----------------------------------------------------
        // Open Available Material
        //----------------------------------------------------

        console.log('Opening Available Material...');

        await page.goto(
            'https://excess.acciaiterni.it/cambiaFunzioneUtenteAttiva?funzioneUtenteAttiva=1',
            { waitUntil: 'networkidle' }
        );

        //----------------------------------------------------
        // Wait for table
        //----------------------------------------------------

        console.log('Waiting for inventory table...');

        await page.waitForSelector('#idTabella', {
            timeout: 60000
        });

        await page.waitForSelector('#idTabella tbody tr', {
            timeout: 60000
        });

        //----------------------------------------------------
        // Set 100 rows/page safely
        //----------------------------------------------------

        console.log('Changing page size to 100...');

        if (await page.$('#idTabella_length select')) {
            await page.selectOption('#idTabella_length select', '100');
        }

        await page.waitForFunction(() => {
            const infoText = document.querySelector('#idTabella_info')?.textContent || '';
            const match = infoText.match(/Showing \d+ to (\d+) of (\d+) entries/i);
            if (!match) return false;

            const visibleCount = parseInt(match[1], 10);
            const totalEntries = parseInt(match[2], 10);
            const actualRows = document.querySelectorAll('#idTabella tbody tr').length;

            if (totalEntries === 0) return true;

            return actualRows === visibleCount;
        }, { timeout: 30000 });

        console.log('Table fully loaded.');

        //----------------------------------------------------
        // Scrape all pages
        //----------------------------------------------------

        let allScrapedData = [];
        let pageNumber = 1;

        while (true) {

            console.log(`Scraping page ${pageNumber}...`);

            const pageData = await page.$$eval('#idTabella tbody tr', rows => {

                return rows.map(row => {

                    const columns = row.querySelectorAll('td');

                    if (columns.length < 13) return null;

                    return {

                        Coil: columns[1].innerText.trim(),

                        KG: columns[2].innerText.trim(),

                        SteelGrade: columns[3].innerText.trim(),

                        Thick: columns[4].innerText.trim(),

                        Width: columns[5].innerText.trim(),

                        Length: columns[6].innerText.trim(),

                        Shape: columns[7].innerText.trim(),

                        Edge: columns[8].innerText.trim(),

                        Choice: columns[9].innerText.trim(),

                        Finish: columns[10].innerText.trim(),

                        PVC: columns[11].innerText.trim(),

                        Price: columns[12].innerText.trim()

                    };

                }).filter(Boolean);

            });

            allScrapedData.push(...pageData);

            console.log(`Collected ${allScrapedData.length} rows.`);

            const nextButton = page.locator('#idTabella_next');

            const isNextDisabled = await nextButton.evaluate(el => 
                el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'
            ).catch(() => true);

            if (isNextDisabled) {
                console.log('Last page reached or single page available.');
                break;
            }

            const firstRowBefore = await page.locator('#idTabella tbody tr').first().textContent();

            await nextButton.click();

            await page.waitForFunction(previous => {
                const row = document.querySelector('#idTabella tbody tr');
                return row && row.textContent !== previous;
            }, firstRowBefore);

            pageNumber++;

        }

        //----------------------------------------------------
        // Export Excel
        //----------------------------------------------------

        console.log(`Finished. Total rows: ${allScrapedData.length}`);

        const worksheet = xlsx.utils.json_to_sheet(allScrapedData);

        const workbook = xlsx.utils.book_new();

        xlsx.utils.book_append_sheet(workbook, worksheet, 'Arvedi AST');

        xlsx.writeFile(workbook, 'arvedi_data.xlsx');

        console.log('Excel exported successfully.');

        await browser.close();

    } catch (err) {

        console.error(err);

        if (browser) {

            try {

                const pages = await browser.contexts()[0]?.pages();

                if (pages && pages.length) {

                    await pages[0].screenshot({
                        path: 'debug.png',
                        fullPage: true
                    });

                    fs.writeFileSync(
                        'page.html',
                        await pages[0].content()
                    );

                }

            } catch {}

            await browser.close();

        }

        process.exit(1);

    }

})();
