import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import { PDFDocument, degrees } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// Artifact storage directories
const SCREENSHOT_DIR = path.resolve('screenshots');
const OUTPUT_DIR = path.resolve('output');
const DOWNLOADS_DIR = path.resolve('downloads');

[SCREENSHOT_DIR, OUTPUT_DIR, DOWNLOADS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Timing knobs. If the portal ever acts up (clicks landing too early, lists not
// refreshed), raise these first.
// ---------------------------------------------------------------------------
const SETTLE_MS = 250;        // pause after every spinner/overlay wait (was 1000)
const SLEEP_SHORT_MS = 150;   // tiny UI settle (was 300-1000)
const SLEEP_MEDIUM_MS = 400;  // settle after a server-filtered list refresh (was 1000)
const TYPE_DELAY_MS = 25;     // per-keystroke delay in the student search box (was 60)
const RETRY_PAUSE_MS = 2000;  // pause between click retries (unchanged)

// Screenshots are only taken when something fails. To capture every step again
// (for debugging), run with SCREENSHOTS=all.
const SCREENSHOTS_ALL = process.env.SCREENSHOTS === 'all';


// ---------------------------------------------------------------------------
// Live progress reporting
// Posts each [PROGRESS] line to a GitHub "check run" so the desktop app can show
// it live (GitHub's job-log API returns 404 until a job finishes).
// Needs `checks: write` permission + GITHUB_TOKEN in the workflow. Outside GitHub
// Actions (or if anything fails) it silently falls back to console output only.
// ---------------------------------------------------------------------------
const PROGRESS_CHECK_NAME = 'student-progress';
let progressCheckId = null;

function githubApi(pathname, method, body) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  return fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
}

async function reportProgress(line) {
  console.log(`[PROGRESS] ${line}`);
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA) return;

  const output = { title: line.slice(0, 250), summary: line };
  try {
    if (!progressCheckId) {
      const res = await githubApi('/check-runs', 'POST', {
        name: PROGRESS_CHECK_NAME,
        head_sha: GITHUB_SHA,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        output,
      });
      if (res.ok) progressCheckId = (await res.json()).id;
      else console.warn(`[PROGRESS WARN] check-run create failed: ${res.status}`);
    } else {
      const res = await githubApi(`/check-runs/${progressCheckId}`, 'PATCH', { output });
      if (!res.ok) console.warn(`[PROGRESS WARN] check-run update failed: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[PROGRESS WARN] ${err.message}`);
  }
}

async function finishProgress() {
  if (!progressCheckId) return;
  try {
    await githubApi(`/check-runs/${progressCheckId}`, 'PATCH', {
      status: 'completed',
      conclusion: 'neutral',
      completed_at: new Date().toISOString(),
    });
  } catch (_) {}
}

let stepCounter = 1;

async function snap(page, stepName, { force = false } = {}) {
  if (!force && !SCREENSHOTS_ALL) return;
  const safeName = `${String(stepCounter++).padStart(3, '0')}_${stepName.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
  const filePath = path.join(SCREENSHOT_DIR, safeName);
  try {
    await page.screenshot({ path: filePath, fullPage: false, timeout: 10000 });
    console.log(`[SNAPSHOT] Saved: ${safeName}`);
  } catch (err) {
    console.warn(`[SNAPSHOT WARN] Failed to capture ${safeName}: ${err.message}`);
  }
}

// Always captures, used only on failures.
function snapFailure(page, stepName) {
  return snap(page, `FAIL_${stepName}`, { force: true });
}

async function waitDimmed(page, timeoutMs = 70000) {
  console.log('[SPINNER] Waiting for loading backdrop/fade to vanish...');
  try {
    await page.waitForSelector('.fade', { state: 'hidden', timeout: timeoutMs }).catch(() => {});
    await page.waitForSelector('.blockUI', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
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
      await snapFailure(page, `${stepLabel}_attempt${attempt}`);
      if (attempt === maxRetries) throw err;
      await page.waitForTimeout(RETRY_PAUSE_MS);
    }
  }
}

// --- date range helpers ---------------------------------------------------
// The desktop app passes START_DATE / END_DATE (YYYY-MM-DD) through the workflow.
// Without them (scheduled or manual runs) the last 7 days ending today are used.
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

const dateKey = (d) => d.year * 10000 + d.month * 100 + d.day;
const formatDate = (d) => `${String(d.month).padStart(2, '0')}/${String(d.day).padStart(2, '0')}/${d.year}`;

function shiftDate(d, days) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

// "Today" as the portal sees it (US Eastern). The PC running the desktop app can be a
// day ahead (e.g. Cairo), and the portal's datepicker does not allow future dates.
function portalToday() {
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const now = new Date();
  return parseIsoDate(todayIso) ||
    { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

function resolveDateRange(env = process.env) {
  const startRaw = (env.START_DATE || '').trim();
  const endRaw = (env.END_DATE || '').trim();
  const today = portalToday();

  if (startRaw || endRaw) {
    let start = parseIsoDate(startRaw);
    let end = parseIsoDate(endRaw);
    if (!start || !end) {
      throw new Error(`START_DATE and END_DATE must both be valid YYYY-MM-DD dates (got "${startRaw}" and "${endRaw}")`);
    }
    if (dateKey(end) < dateKey(start)) {
      throw new Error(`END_DATE (${endRaw}) is before START_DATE (${startRaw})`);
    }
    let source = 'app';
    if (dateKey(end) > dateKey(today)) {
      console.warn(`[DATE WARN] END_DATE ${formatDate(end)} is after the portal's today (${formatDate(today)}); using ${formatDate(today)}`);
      end = today;
      source = 'app, end date limited to portal today';
    }
    if (dateKey(start) > dateKey(end)) start = end;
    return { start, end, source };
  }

  // Fallback: last 7 days ending today, using US Eastern time
  return { start: shiftDate(today, -6), end: today, source: 'default (last 7 days)' };
}

// Opens a bootstrap-datepicker, pages to the right month/year, then clicks the day.
async function pickDate(page, pickerSelector, label, target) {
  await safeClick(page, pickerSelector, `open_${label}_datepicker`);
  const dropdown = page.locator('.datepicker-dropdown:visible').first();
  const header = dropdown.locator('th.datepicker-switch').first();
  const wanted = target.year * 12 + (target.month - 1);

  for (let i = 0; i < 60; i++) {
    const text = ((await header.textContent({ timeout: 10000 })) || '').trim().toLowerCase();
    const [monthName, yearText] = text.split(/\s+/);
    const monthIdx = MONTH_NAMES.indexOf(monthName);
    const year = parseInt(yearText, 10);
    if (monthIdx < 0 || Number.isNaN(year)) {
      throw new Error(`Unrecognized datepicker header "${text}"`);
    }

    const shown = year * 12 + monthIdx;
    if (shown === wanted) {
      const cell = dropdown.locator(`td.day:not(.old):not(.new):not(.disabled):text-is("${target.day}")`).first();
      if ((await cell.count()) === 0) {
        throw new Error(`The ${label} date ${formatDate(target)} is not selectable in the portal datepicker (disabled or missing day)`);
      }
      await cell.click();
      console.log(`[ACTION] Picked ${label} date: ${formatDate(target)}`);
      await waitDimmed(page);
      return;
    }

    await dropdown.locator(shown > wanted ? 'th.prev' : 'th.next').first().click();
    await page.waitForTimeout(SLEEP_SHORT_MS);
  }
  throw new Error(`Could not navigate the datepicker to ${formatDate(target)}`);
}
// --- end date range helpers -----------------------------------------------

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

  // 2. Permit (detected by file contents, not extension: PDF, PNG or JPG)
  if (permitPath && fs.existsSync(permitPath)) {
    try {
      const permitBuffer = fs.readFileSync(permitPath);
      const isPdf = permitBuffer.subarray(0, 5).toString('latin1') === '%PDF-';
      const isPng = permitBuffer.length > 4 && permitBuffer[0] === 0x89 && permitBuffer[1] === 0x50 &&
        permitBuffer[2] === 0x4e && permitBuffer[3] === 0x47;
      const isJpg = permitBuffer.length > 2 && permitBuffer[0] === 0xff && permitBuffer[1] === 0xd8;

      if (isPdf) {
        // PDF permit: copy its pages in as they are
        const permitDoc = await PDFDocument.load(permitBuffer);
        const pages = await finalDoc.copyPages(permitDoc, permitDoc.getPageIndices());
        pages.forEach((p) => finalDoc.addPage(p));
        console.log(`[MERGE] Merged PDF permit (${pages.length} page(s)) for ${studentName}`);
      } else if (isPng || isJpg) {
        // Image permit: rotated clockwise to be upright, centered on a single letter page
        const img = isPng ? await finalDoc.embedPng(permitBuffer) : await finalDoc.embedJpg(permitBuffer);

        const page = finalDoc.addPage([612, 792]); // Standard US Letter
        const margin = 40;
        const maxWidth = 612 - margin * 2;
        const maxHeight = 792 - margin * 2;

        // Because the image is oriented sideways, its dimensions swap
        const scale = Math.min(maxWidth / img.height, maxHeight / img.width, 1);
        const renderW = img.width * scale;
        const renderH = img.height * scale;

        const centerX = 612 / 2;
        const centerY = 792 / 2;

        // Rotate 90° clockwise (degrees(-90)) with proper origin shift
        page.drawImage(img, {
          x: centerX - renderH / 2,
          y: centerY - renderW / 2 + renderW,
          width: renderW,
          height: renderH,
          rotate: degrees(-90),
        });

        console.log(`[MERGE] Embedded upright permit image for ${studentName}`);
      } else {
        console.error(`[MERGE ERROR] Permit for ${studentName} is not a PDF, PNG or JPG (${permitPath})`);
      }
    } catch (err) {
      console.error(`[MERGE ERROR] Failed embedding permit: ${err.message}`);
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
  if (!process.env.PORTAL_URL || !process.env.PORTAL_USER || !process.env.PORTAL_PASS) {
    console.error('[FATAL ERROR]: PORTAL_URL, PORTAL_USER and PORTAL_PASS must be set (add them as GitHub secrets and pass them in the workflow env).');
    process.exit(1);
  }

  let dateRange;
  try {
    dateRange = resolveDateRange();
  } catch (err) {
    console.error(`[FATAL ERROR]: ${err.message}`);
    process.exit(1);
  }

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
    await page.goto(process.env.PORTAL_URL, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await snap(page, 'login_page_loaded');

    await page.fill('#username', process.env.PORTAL_USER);
    await page.fill('#password', process.env.PORTAL_PASS);
    await snap(page, 'login_credentials_filled');

    // noWaitAfter: the click itself must not wait for the post-login page to fully load
    // (that page can hang on slow/never-finishing requests and made the click time out).
    await page.click('button.btn.green-haze:has-text("Login")', { noWaitAfter: true });
    console.log('[STEP 1] Submitted login. Waiting for portal load...');
    try {
      await page.waitForURL((u) => !/\/Login\/Login/i.test(u.href), {
        waitUntil: 'commit',
        timeout: 60000,
      });
      console.log('[STEP 1] Left the login page.');
    } catch (_) {
      const errText = await page
        .locator('.alert-danger, .alert, .text-danger, #divMessage, .field-validation-error')
        .allInnerTexts()
        .catch(() => []);
      console.warn(`[LOGIN WARN] Still on login page after 60s. Page messages: ${JSON.stringify(errText.filter(Boolean))}`);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
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

    // Pick the date range chosen in the desktop app (default: last 7 days)
    console.log(`[STEP 3] Report range: ${formatDate(dateRange.start)} to ${formatDate(dateRange.end)} [${dateRange.source}]`);
    await pickDate(page, '#startDatePicker_reportBTWHoursCompleted', 'start', dateRange.start);
    await pickDate(page, '#endDatePicker_reportBTWHoursCompleted', 'end', dateRange.end);

    // 4. Download Excel Report
    console.log('[STEP 4] Exporting BTW report to Excel...');
    const [downloadEvent] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      safeClick(page, 'a.btn.green:has-text("Export Into Excel")', 'click_export_excel'),
    ]);

    const excelFilePath = path.join(DOWNLOADS_DIR, 'BTWHoursCompleted.xlsx');
    await downloadEvent.saveAs(excelFilePath);
    console.log(`[STEP 4] Downloaded file to: ${excelFilePath}`);

    // Parse Excel with SheetJS
    const fileBuffer = fs.readFileSync(excelFilePath);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const students = [];
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

    const totalStudents = students.length;
    console.log(`[INFO] Found ${totalStudents} student(s) to process.`);

    // 5. Loop Students
    for (let idx = 0; idx < totalStudents; idx++) {
      const student = students[idx];
      const currentNum = idx + 1;

      try {

      console.log(`\n======================================================`);
      await reportProgress(`${currentNum}/${totalStudents} | ${student.fullName} | Initializing profile`);
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
      await reportProgress(`${currentNum}/${totalStudents} | ${student.fullName} | Locating student record`);
      const iCheckWrapper = page.locator('.icheckbox_square-grey');
      if (await iCheckWrapper.count() > 0) {
        const isChecked = await iCheckWrapper.first().evaluate(el => el.classList.contains('checked'));
        if (isChecked) {
          console.log('[STUDENT] Unchecking "ACTIVE STUDENTS ONLY"...');
          await iCheckWrapper.first().click();
          await waitDimmed(page);
        }
      } else {
        await page.locator('label:has-text("ACTIVE STUDENTS ONLY"), span:has-text("ACTIVE STUDENTS ONLY")').first().click().catch(() => {});
      }
      await snap(page, 'after_uncheck_active_only');

      const studentInput = page.locator('#studentList');
      await studentInput.click();
      await studentInput.fill('');
      await page.waitForTimeout(SLEEP_SHORT_MS);

      await studentInput.pressSequentially(student.lastName, { delay: TYPE_DELAY_MS });
      await snap(page, `typed_student_${student.lastName}`);

      const autocompleteItem = page
        .locator('.k-animation-container ul li.k-item, #studentList_listbox li.k-item')
        .filter({ hasText: student.firstName })
        .first();
      await autocompleteItem.waitFor({ state: 'visible', timeout: 10000 });
      await autocompleteItem.click();
      await snap(page, 'selected_autocomplete_item');
      await waitDimmed(page);

      await safeClick(page, 'a.btn.green[onclick*="RedirectToStudentAccountPage"], a:text-is("Go")', 'click_student_go');
      await waitDimmed(page);
      await snap(page, 'student_account_loaded');

      // 5c. Files Tab
      await reportProgress(`${currentNum}/${totalStudents} | ${student.fullName} | Compiling contract & driver permit`);
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

      // 5d. Enrollment / Billing Receipt via Modal Print
      await reportProgress(`${currentNum}/${totalStudents} | ${student.fullName} | Generating verified receipt`);
      const billingTab = page.locator('ul.nav-tabs a.tabBillingEnrollment[href="#tb_billing"], a[onclick*="_FetchEnrollmentBillingView"]');
      await billingTab.waitFor({ state: 'visible', timeout: 15000 });
      await billingTab.click();
      await waitDimmed(page);
      await snap(page, `billing_tab_loaded_${student.lastName}`);

      // Open Print Modal
      console.log('[STUDENT] Opening Print Enrollments/Billing modal...');
      const billingHeaderPrintBtn = page.locator('#divBillingGrid a.btn.blue.btn-sm[onclick*="GetbillingAndEnrollmentForPrintGulAndEmail"], #divBillingGrid a:has-text("PRINT")').first();
      await billingHeaderPrintBtn.waitFor({ state: 'visible', timeout: 20000 });
      await billingHeaderPrintBtn.click();
      await page.waitForTimeout(SLEEP_SHORT_MS);
      await snap(page, `print_modal_opened_${student.lastName}`);

      const modal = page.locator('#Print_Enroll_billing_info');
      await modal.waitFor({ state: 'visible', timeout: 15000 });
      await modal.locator('#Receipt_BillingAndEnrollmentHtml').waitFor({ state: 'visible', timeout: 15000 });

      // Target oldest billing checkbox (last item in right column)
      console.log('[STUDENT] Selecting oldest receipt checkbox...');
      const billingBoxes = modal.locator('.col-md-6').last().locator('.icheckbox_square-grey');
      const billingBoxCount = await billingBoxes.count();
      if (billingBoxCount > 0) {
        await billingBoxes.last().click();
      } else {
        await modal.locator('label').filter({ hasText: '$' }).last().click();
      }
      await page.waitForTimeout(SLEEP_SHORT_MS);
      await snap(page, `modal_selected_oldest_${student.lastName}`);

      const modalPrintBtn = modal.locator('a.btn.green[onclick*="GetReceiptofEnrollmentAndBilling"], a.btn.green:has-text("PRINT")').first();
      const [printPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 30000 }),
        modalPrintBtn.click(),
      ]);

      await printPage.waitForLoadState('networkidle');
      await snap(printPage, `receipt_opened_${student.lastName}`);

      studentDocs.billingPath = path.join(DOWNLOADS_DIR, `${student.lastName}_billing_receipt.pdf`);
      await printPage.pdf({ path: studentDocs.billingPath, format: 'Letter', printBackground: true });
      console.log(`[STUDENT] Generated billing PDF: ${studentDocs.billingPath}`);
      await printPage.close();

      const closeBtn = modal.locator('button[data-dismiss="modal"]:has-text("CLOSE"), button:has-text("CLOSE")').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await waitDimmed(page);

      // 5e. Report Center -> Class D Log
      await reportProgress(`${currentNum}/${totalStudents} | ${student.fullName} | Retrieving official Class D Log`);
      await safeClick(page, '#ReportCenterSideMenu > a, a:has-text("Report Center")', 'open_report_center');
      await safeClick(page, '#rc_SCStateFormsReports a, a:has-text("SC Reports/Forms")', 'click_sc_reports');
      await waitDimmed(page);

      // Class D LOG card specifically
      const classDCard = page.locator('a.ClsType[data-type="2"]').first();
      await classDCard.waitFor({ state: 'visible', timeout: 20000 });
      await classDCard.click();
      await waitDimmed(page);
      await page.waitForTimeout(SLEEP_SHORT_MS);

      await snap(page, `opened_class_d_modal_${student.lastName}`);

      const searchBox = page.locator('#txt_SCStateForms_TempAuthForm_SearchStudentByLastName');
      await searchBox.waitFor({ state: 'visible', timeout: 15000 });
      await searchBox.fill(student.lastName);

      const filterBtn = page.locator('#btn_WAStateForms_TempAuthForm_FetchStudentByLastName');
      await filterBtn.click();
      await waitDimmed(page);
      await page.waitForTimeout(SLEEP_MEDIUM_MS);

      const studentsSelect = page.locator('#select_SCStateForms_StudentsList_TempAuthForm');
      await studentsSelect.waitFor({ state: 'visible', timeout: 15000 });

      const targetOption = studentsSelect.locator('option').filter({
        hasText: new RegExp(`^\\s*${student.lastName},\\s*${student.firstName}`, 'i')
      }).first();

      let targetVal = null;
      if (await targetOption.count() > 0) {
        targetVal = await targetOption.getAttribute('value');
      } else {
        const allOptions = await studentsSelect.locator('option').all();
        for (const opt of allOptions) {
          const txt = (await opt.textContent()).toLowerCase();
          if (txt.includes(student.lastName.toLowerCase()) && txt.includes(student.firstName.toLowerCase())) {
            targetVal = await opt.getAttribute('value');
            break;
          }
        }
      }

      if (targetVal) {
        console.log(`[STUDENT] Selected option ID: ${targetVal} for ${student.fullName}`);
        await studentsSelect.selectOption(targetVal);
      } else {
        console.warn(`[STUDENT WARN] Could not find option for ${student.lastName}, ${student.firstName}`);
      }

      await page.waitForTimeout(SLEEP_SHORT_MS);
      await snap(page, `selected_class_d_${student.lastName}`);

      const [classDDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 35000 }),
        safeClick(page, '#btn_SCStateForms_Download_TempAuthFrom', 'click_create_pdf_class_d'),
      ]);

      studentDocs.classDPath = path.join(DOWNLOADS_DIR, `${student.lastName}_class_d_log.pdf`);
      await classDDownload.saveAs(studentDocs.classDPath);
      console.log(`[STUDENT] Saved Class D Log: ${studentDocs.classDPath}`);

      const modalClose = page.locator('#modal_WAStateForms_TempAuthForm button[data-dismiss="modal"]:has-text("CLOSE"), #modal_WAStateForms_TempAuthForm button.close').first();
      if (await modalClose.isVisible().catch(() => false)) {
        await modalClose.click();
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await waitDimmed(page);

      // 5f. Merge Final Packet
      await reportProgress(`${currentNum}/${totalStudents} | ${student.fullName} | Compiling unified PDF packet`);
      await assembleStudentPdf(student.fullName, studentDocs);
      } catch (err) {
        console.error(`[SKIPPED] ${student.fullName}: ${err.message}`);
        await snapFailure(page, `skipped_${student.lastName}`);
        continue;
      }
    }

    console.log('\n[COMPLETE] All student packets have been scraped and merged.');
  } catch (error) {
    console.error(`[FATAL ERROR]: ${error.stack}`);
    await snapFailure(page, 'fatal_crash_state');
    process.exitCode = 1;
  } finally {
    await finishProgress();
    await browser.close();
  }
})();
