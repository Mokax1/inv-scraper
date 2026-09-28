import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// Artifact storage directories
const SCREENSHOT_DIR = path.resolve('screenshots');
const OUTPUT_DIR = path.resolve('output');
const DOWNLOADS_DIR = path.resolve('downloads');

[SCREENSHOT_DIR, OUTPUT_DIR, DOWNLOADS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let stepCounter = 1;

async function snap(page, stepName) {
  const safeName = `${String(stepCounter++).padStart(3, '0')}_${stepName.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  const filePath = path.join(SCREENSHOT_DIR, safeName);
  try {
    await page.screenshot({ path: filePath, fullPage: false });
    console.log(`[SNAPSHOT] Saved: ${safeName}`);
  } catch (err) {
    console.warn(`[SNAPSHOT WARN] Failed to capture ${safeName}: ${err.message}`);
  }
}

async function waitDimmed(page, timeoutMs = 70000) {
  console.log('[SPINNER] Waiting for loading backdrop/fade to vanish...');
  try {
    await page.waitForSelector('.fade', { state: 'hidden', timeout: timeoutMs }).catch(() => {});
    await page.waitForSelector('.blockUI', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } catch (err) {
    console.warn(`[SPINNER WARN] Overlay wait timed out or failed: ${err.message}`);
  }
}

async function safeClick(page, selector, stepLabel, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitDimmed(page);
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'attached', timeout: 30000 });
      await el.scrollIntoViewIfNeeded();
      await el.waitFor({ state: 'visible', timeout: 15000 });
      await el.click({ timeout: 15000 });
      console.log(`[ACTION] Clicked: ${stepLabel}`);
      await snap(page, `after_${stepLabel}`);
      await waitDimmed(page);
      return;
    } catch (err) {
      console.warn(`[RETRY ${attempt}/${maxRetries}] Failed to click "${stepLabel}": ${err.message}`);
      if (attempt === maxRetries) throw err;
      await page.waitForTimeout(2000);
    }
  }
}

async function assembleStudentPdf(studentName, { contractPath, permitPath, billingPath, classDPath }) {
  const finalDoc = await PDFDocument.create();

  // 1. Contract PDF
  if (contractPath && fs.existsSync(contractPath)) {
    try {
      const contractDoc = await PDFDocument.load(fs.readFileSync(contractPath));
      const pages = await finalDoc.copyPages(contractDoc, contractDoc.getPageIndices());
      pages.forEach((p) => finalDoc.addPage(p));
      console.log(`[MERGE] Merged contract for ${studentName}`);
    } catch (err) {
      console.error(`[MERGE ERROR] Failed loading contract: ${err.message}`);
    }
  }

  // 2. Permit Photo (scaled to fit single letter page)
  if (permitPath && fs.existsSync(permitPath)) {
    try {
      const imgBuffer = fs.readFileSync(permitPath);
      let img;
      if (permitPath.endsWith('.png')) {
        img = await finalDoc.embedPng(imgBuffer);
      } else {
        img = await finalDoc.embedJpg(imgBuffer);
      }

      const page = finalDoc.addPage([612, 792]);
      const margin = 40;
      const maxWidth = 612 - margin * 2;
      const maxHeight = 792 - margin * 2;

      const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
      const renderW = img.width * scale;
      const renderH = img.height * scale;

      page.drawImage(img, {
        x: (612 - renderW) / 2,
        y: (792 - renderH) / 2,
        width: renderW,
        height: renderH,
      });
      console.log(`[MERGE] Embedded permit image for ${studentName}`);
    } catch (err) {
      console.error(`[MERGE ERROR] Failed embedding permit image: ${err.message}`);
    }
  }

  // 3. Billing Receipt PDF
  if (billingPath && fs.existsSync(billingPath)) {
    try {
      const billingDoc = await PDFDocument.load(fs.readFileSync(billingPath));
      const pages = await finalDoc.copyPages(billingDoc, billingDoc.getPageIndices());
      pages.forEach((p) => finalDoc.addPage(p));
      console.log(`[MERGE] Merged billing receipt for ${studentName}`);
    } catch (err) {
      console.error(`[MERGE ERROR] Failed loading billing PDF: ${err.message}`);
    }
  }

  // 4. Class D Log PDF
  if (classDPath && fs.existsSync(classDPath)) {
    try {
      const classDDoc = await PDFDocument.load(fs.readFileSync(classDPath));
      const pages = await finalDoc.copyPages(classDDoc, classDDoc.getPageIndices());
      pages.forEach((p) => finalDoc.addPage(p));
      console.log(`[MERGE] Merged Class D Log for ${studentName}`);
    } catch (err) {
      console.error(`[MERGE ERROR] Failed loading Class D PDF: ${err.message}`);
    }
  }

  const safeFilename = `${studentName.replace(/[^a-zA-Z0-9_-]/g, '_')}_Complete_Packet.pdf`;
  const targetPath = path.join(OUTPUT_DIR, safeFilename);
  const pdfBytes = await finalDoc.save();
  fs.writeFileSync(targetPath, pdfBytes);
  console.log(`[SUCCESS] Saved master PDF to: ${targetPath}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });

  const page = await context.newPage();

  try {
    console.log('[STEP 1] Navigating to Login Page...');
    await page.goto('https://tdsm.app/CentralizeAdmin/Login/Login?encId=PorpdwJMjHo_EQUAL_', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await snap(page, 'login_page_loaded');

    await page.fill('#username', process.env.PORTAL_USER || 'Guest1');
    await page.fill('#password', process.env.PORTAL_PASS || 'Learntodrive2');
    await snap(page, 'login_credentials_filled');

    await page.click('button.btn.green-haze:has-text("Login")');
    console.log('[STEP 1] Submitted login. Waiting for portal load...');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await waitDimmed(page);
    await snap(page, 'post_login_homepage');

    // 2. Open Report Center -> Business Reports
    console.log('[STEP 2] Opening Report Center...');
    const reportCenterMenu = page.locator('#ReportCenterSideMenu > a, li#ReportCenterSideMenu, a:has-text("Report Center")').first();
    await reportCenterMenu.waitFor({ state: 'attached', timeout: 30000 });
    await reportCenterMenu.scrollIntoViewIfNeeded();
    await safeClick(page, '#ReportCenterSideMenu > a, a:has-text("Report Center")', 'click_report_center_menu');

    await safeClick(page, 'a.ReportCenter_BusinessReports, a:has-text("Business Reports")', 'click_business_reports');
    await waitDimmed(page);

    // 3. Select BTW Hours Completed & Configure Date Pickers
    console.log('[STEP 3] Loading All BTW Hours Completed...');
    await safeClick(page, 'a.reportstudenteventlog[data-reportid="4"], a:has-text("All BTW Hours Completed")', 'click_btw_hours_report');
    await waitDimmed(page);

    // Pick Start Date (21 Sep)
    console.log('[STEP 3] Setting start date (21 Sep)...');
    await safeClick(page, '#startDatePicker_reportBTWHoursCompleted', 'open_start_datepicker');
    const startCell = page.locator('.datepicker-dropdown:visible td.day:not(.old):not(.new):text-is("21")').first();
    await startCell.click();
    await waitDimmed(page);

    // Pick End Date (28 Sep)
    console.log('[STEP 3] Setting end date (28 Sep)...');
    await safeClick(page, '#endDatePicker_reportBTWHoursCompleted', 'open_end_datepicker');
    const endCell = page.locator('.datepicker-dropdown:visible td.day:not(.old):not(.new):text-is("28")').first();
    await endCell.click();
    await waitDimmed(page);

    // 4. Download Excel Report
    console.log('[STEP 4] Exporting BTW report to Excel...');
    const [downloadEvent] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      safeClick(page, 'a.btn.green:has-text("Export Into Excel")', 'click_export_excel'),
    ]);

    const excelFilePath = path.join(DOWNLOADS_DIR, 'BTWHoursCompleted.xlsx');
    await downloadEvent.saveAs(excelFilePath);
    console.log(`[STEP 4] Downloaded file to: ${excelFilePath}`);

    // Parse Excel with SheetJS (bypasses XML BOM issues)
    const fileBuffer = fs.readFileSync(excelFilePath);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const students = [];
    // Row 0 is header: ['First Name', 'Last Name', ...]
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const firstName = String(row[0] || '').trim();
      const lastName = String(row[1] || '').trim();
      if (firstName && lastName) {
        students.push({
          firstName,
          lastName,
          fullName: `${firstName} ${lastName}`,
        });
      }
    }

    console.log(`[INFO] Found ${students.length} student(s) to process.`);

    // 5. Loop Students
    for (const student of students) {
      console.log(`\n======================================================`);
      console.log(`[PROCESSING] Student: ${student.fullName}`);
      console.log(`======================================================`);

      const studentDocs = {
        contractPath: null,
        permitPath: null,
        billingPath: null,
        classDPath: null,
      };

      // 5a. Return to Home Page
      await safeClick(page, 'a[href*="/CentralizeAdmin/NewHomePage/NewHomePage"], a:has-text("Home")', 'nav_home');
      await waitDimmed(page);

      // 5b. Search Student
      console.log(`[STUDENT] Searching for "${student.lastName} ${student.firstName}"...`);

      // 1. Uncheck "ACTIVE STUDENTS ONLY" via the iCheck visual wrapper or label
      const iCheckWrapper = page.locator('.icheckbox_square-grey');
      if (await iCheckWrapper.count() > 0) {
        // If it currently has the 'checked' class, click it to uncheck
        const isChecked = await iCheckWrapper.first().evaluate(el => el.classList.contains('checked'));
        if (isChecked) {
          console.log('[STUDENT] Unchecking "ACTIVE STUDENTS ONLY"...');
          await iCheckWrapper.first().click();
          await waitDimmed(page);
        }
      } else {
        // Fallback: click the text label
        await page.locator('label:has-text("ACTIVE STUDENTS ONLY"), span:has-text("ACTIVE STUDENTS ONLY")').first().click().catch(() => {});
      }
      await snap(page, 'after_uncheck_active_only');

      // 2. Clear input, click into it, and type characters sequentially to trigger Kendo UI AJAX
      const studentInput = page.locator('#studentList');
      await studentInput.click();
      await studentInput.fill(''); // clear any residual text
      await page.waitForTimeout(300);

      // Typing sequentially triggers keydown/keyup events needed by Kendo autocomplete
      await studentInput.pressSequentially(`${student.lastName} ${student.firstName}`, { delay: 60 });
      await snap(page, `typed_student_${student.lastName}`);

      // 3. Wait for Kendo autocomplete dropdown to populate and select option
      const autocompleteItem = page.locator('.k-animation-container ul li.k-item, #studentList_listbox li.k-item, li.k-item').first();
      await autocompleteItem.waitFor({ state: 'visible', timeout: 20000 });
      await autocompleteItem.click();
      await snap(page, 'selected_autocomplete_item');
      await waitDimmed(page);

      // 4. Click Go
      await safeClick(page, 'a.btn.green[onclick*="RedirectToStudentAccountPage"], a:text-is("Go")', 'click_student_go');
      await waitDimmed(page);
      await snap(page, 'student_account_loaded');

      // 5c. Files Tab
      await safeClick(page, 'strong.text-uppercase:has-text("Files"), a[href*="Files"]', 'click_files_tab');
      await waitDimmed(page);

      // Oldest Contract
      const contractRows = page.locator('#divFilesListPanel .studentfilerow:has-text("Student Contract")');
      const contractCount = await contractRows.count();
      if (contractCount > 0) {
        console.log(`[STUDENT] Found ${contractCount} contract(s). Selecting oldest...`);
        const oldestContractRow = contractRows.nth(contractCount - 1);
        const downloadBtn = oldestContractRow.locator('a[href*="download_FileFromBlob"][href*="type=1"]');
        const [downloadContract] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          downloadBtn.click(),
        ]);
        studentDocs.contractPath = path.join(DOWNLOADS_DIR, `${student.lastName}_contract.pdf`);
        await downloadContract.saveAs(studentDocs.contractPath);
        console.log(`[STUDENT] Saved contract: ${studentDocs.contractPath}`);
      }

      // Newest Permit
      const permitRows = page.locator('#divFilesListPanel .studentfilerow:has-text("Permit")');
      const permitCount = await permitRows.count();
      if (permitCount > 0) {
        console.log(`[STUDENT] Found ${permitCount} permit(s). Selecting newest...`);
        const newestPermitRow = permitRows.first();
        const downloadBtn = newestPermitRow.locator('a[href*="download_FileFromBlob"][href*="type=1"]');
        const [downloadPermit] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          downloadBtn.click(),
        ]);
        const ext = downloadPermit.suggestedFilename().split('.').pop() || 'jpg';
        studentDocs.permitPath = path.join(DOWNLOADS_DIR, `${student.lastName}_permit.${ext}`);
        await downloadPermit.saveAs(studentDocs.permitPath);
        console.log(`[STUDENT] Saved permit: ${studentDocs.permitPath}`);
      }

   // 5d. Enrollment / Billing Receipt
      console.log('[STUDENT] Navigating to Enrollment/Billing tab...');
      const billingTab = page.locator('ul.nav-tabs a.tabBillingEnrollment[href="#tb_billing"], a[onclick*="_FetchEnrollmentBillingView"]');
      await billingTab.waitFor({ state: 'visible', timeout: 15000 });
      await billingTab.click();
      await waitDimmed(page);
      await snap(page, `billing_tab_loaded_${student.lastName}`);

      // Wait specifically for #billingtableid to populate
      const billingTable = page.locator('#billingtableid');
      await billingTable.waitFor({ state: 'visible', timeout: 25000 });

      // Click the EDIT dropdown button on the first row of #billingtableid (the oldest receipt)
      console.log('[STUDENT] Opening EDIT dropdown on row 1 of #billingtableid...');
      const firstRowEditBtn = billingTable.locator('tbody tr').first().locator('a[data-toggle="dropdown"], a.btn.blue');
      await firstRowEditBtn.waitFor({ state: 'visible', timeout: 15000 });
      await firstRowEditBtn.click();
      await page.waitForTimeout(600); // Allow the detached menu to appear under <body>
      await snap(page, `billing_edit_dropdown_opened_${student.lastName}`);

      // The menu is appended to <body>: find the visible link matching 'billing' and 'Print'
      const printLink = page.locator('ul.dropdown-menu[style*="display: block"] a[onclick*="billing"], a:visible[onclick*="billing"]:has-text("Print")').first();
      await printLink.waitFor({ state: 'visible', timeout: 15000 });

      // Intercept the new tab/window when clicking Print
      const [printPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 30000 }),
        printLink.click(),
      ]);

      await printPage.waitForLoadState('networkidle');
      await snap(printPage, `billing_receipt_page_${student.lastName}`);

      // Save billing PDF directly from the print preview tab
      studentDocs.billingPath = path.join(DOWNLOADS_DIR, `${student.lastName}_billing_receipt.pdf`);
      await printPage.pdf({ path: studentDocs.billingPath, format: 'Letter', printBackground: true });
      console.log(`[STUDENT] Generated billing PDF: ${studentDocs.billingPath}`);
      await printPage.close();

      // 5e. Report Center -> Class D Log
      console.log('[STUDENT] Fetching Class D Log...');
      await safeClick(page, '#ReportCenterSideMenu > a, a:has-text("Report Center")', 'open_report_center');
      await safeClick(page, '#rc_SCStateFormsReports a, a:has-text("SC Reports/Forms")', 'click_sc_reports');
      await waitDimmed(page);

      await safeClick(page, 'a.ClsType[data-target="#modal_WAStateForms_TempAuthForm"], a:has-text("Class D LOG")', 'click_class_d_log');
      await waitDimmed(page);

      const searchBox = page.locator('#txt_SCStateForms_TempAuthForm_SearchStudentByLastName');
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.fill(student.lastName);
      await safeClick(page, '#btn_WAStateForms_TempAuthForm_FetchStudentByLastName', 'filter_student_last_name');
      await waitDimmed(page);

      const studentOption = page.locator('#select_SCStateForms_StudentsList_TempAuthForm option', {
        hasText: student.lastName,
      }).first();
      await studentOption.waitFor({ state: 'visible', timeout: 15000 });
      const optionValue = await studentOption.getAttribute('value');
      await page.selectOption('#select_SCStateForms_StudentsList_TempAuthForm', optionValue);
      await snap(page, `selected_class_d_${student.lastName}`);

      const [classDDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        safeClick(page, '#btn_SCStateForms_Download_TempAuthFrom', 'click_create_pdf_class_d'),
      ]);

      studentDocs.classDPath = path.join(DOWNLOADS_DIR, `${student.lastName}_class_d_log.pdf`);
      await classDDownload.saveAs(studentDocs.classDPath);
      console.log(`[STUDENT] Saved Class D Log: ${studentDocs.classDPath}`);

      await page.keyboard.press('Escape').catch(() => {});
      await waitDimmed(page);

      // 5f. Merge PDFs
      await assembleStudentPdf(student.fullName, studentDocs);
    }

    console.log('\n[COMPLETE] All student packets have been scraped and merged.');
  } catch (error) {
    console.error(`[FATAL ERROR]: ${error.stack}`);
    await snap(page, 'fatal_crash_state');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
