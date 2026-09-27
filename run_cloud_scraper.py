import os
import time
import json
import pandas as pd
from playwright.sync_api import sync_playwright
from processor import normalize_permit_image, combine_documents_to_master

LOGIN_URL = "https://tdsm.app/CentralizeAdmin/Login/Login?encId=PorpdwJMjHo_EQUAL_"
PORTAL_USER = os.getenv("PORTAL_USER")
PORTAL_PASS = os.getenv("PORTAL_PASS")
BRANCH_NAME = os.getenv("BRANCH_NAME", "Charleston")
START_DATE = os.getenv("START_DATE")
END_DATE = os.getenv("END_DATE")

TEMP_DIR = os.path.abspath("temp_downloads")
os.makedirs(TEMP_DIR, exist_ok=True)

def wait_for_spinners(page, extra_delay=1.0):
    try:
        page.locator(".blockUI, .loading, .spinner, .k-loading-image").first.wait_for(
            state="hidden", timeout=30000
        )
    except Exception:
        pass
    time.sleep(extra_delay)

def navigate_sidebar(page, section_text, sub_item_text=None):
    if sub_item_text:
        parent_link = page.locator(f"a:has-text('{section_text}')").first
        sub_link = page.locator(f"a:has-text('{sub_item_text}')").first
        if not sub_link.is_visible():
            parent_link.click()
            time.sleep(1.0)
        sub_link.wait_for(state="visible", timeout=20000)
        sub_link.click()
    else:
        link = page.locator(f"a:has-text('{section_text}')").first
        link.wait_for(state="visible", timeout=20000)
        link.click()
    wait_for_spinners(page, extra_delay=2.0)

def main():
    metadata = []
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        page.on("dialog", lambda dialog: dialog.accept())

        # 1. Login
        print("Logging in headlessly...")
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
        page.locator("input[type='text'], input[name*='user']").first.fill(PORTAL_USER)
        page.locator("input[type='password'], input[name*='pass']").first.fill(PORTAL_PASS)
        page.locator("button:has-text('LOGIN'), input[type='submit']").first.click()
        page.wait_for_url("**/NewHomePage**", timeout=60000)
        wait_for_spinners(page, extra_delay=3.0)

        # 2. Check & Switch Branch
        print(f"Checking branch for: {BRANCH_NAME}...")
        try:
            switch_elem = page.locator(".customswitchto, div[class*='customswitchto']").first
            if switch_elem.is_visible() and BRANCH_NAME.lower() not in switch_elem.inner_text().lower():
                page.locator(".customswitchto .dropdown-toggle").first.click()
                time.sleep(1.0)
                page.locator("#myDropdown a").filter(has_text=BRANCH_NAME).first.click()
                wait_for_spinners(page, extra_delay=3.0)
        except Exception as e:
            print(f"Branch switch note: {e}")

        # 3. BTW Hours Report
        print(f"Fetching report ({START_DATE} to {END_DATE})...")
        navigate_sidebar(page, "Report Center", "Business Reports")
        page.locator("text='All BTW Hours Completed'").first.click()
        wait_for_spinners(page, extra_delay=2.0)

        def clean_date_str(d_str):
            parts = d_str.strip().split("/")
            return f"{int(parts[0])}/{int(parts[1])}/{parts[2]}" if len(parts) == 3 else d_str

        formatted_start = clean_date_str(START_DATE)
        formatted_end = clean_date_str(END_DATE)

        date_setter_js = """
        (inputEl, dateVal) => {
            inputEl.removeAttribute('readonly');
            inputEl.value = dateVal;
            if (window.jQuery) {
                try { window.jQuery(inputEl).datepicker('setDate', dateVal); } catch(e) {}
                window.jQuery(inputEl).trigger('change');
                window.jQuery(inputEl).trigger('input');
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        """
        page.locator("#startDatePicker_reportBTWHoursCompleted input").evaluate(date_setter_js, formatted_start)
        page.locator("#endDatePicker_reportBTWHoursCompleted input").evaluate(date_setter_js, formatted_end)
        time.sleep(1.0)

        with page.expect_download(timeout=90000) as download_info:
            page.locator("a[onclick*='ExportBTWHoursCompleted']").first.click()
        excel_path = os.path.join(TEMP_DIR, "btw_report.xlsx")
        download_info.value.save_as(excel_path)

        df = pd.read_excel(excel_path)
        students = df[["First Name", "Last Name"]].dropna().to_dict("records")
        print(f"Found {len(students)} students.")

        # 4. Process Each Student
        for idx, student in enumerate(students, 1):
            first = str(student["First Name"]).strip()
            last = str(student["Last Name"]).strip()
            full_name = f"{first} {last}"
            safe_name = f"{first}_{last}".replace(" ", "_")
            print(f"[{idx}/{len(students)}] Gathering: {full_name}")

            student_files = []

            navigate_sidebar(page, "Home")
            search_input = page.locator("input#studentList")
            search_input.click()
            search_input.fill(last)

            student_item = page.locator("ul#studentList_listbox li.k-item").filter(has_text=first).first
            student_item.wait_for(state="visible", timeout=25000)
            student_item.click()
            time.sleep(0.5)

            page.locator("a.btn.green[onclick*='RedirectToStudentAccountPage']").first.click()
            wait_for_spinners(page, extra_delay=2.0)

            # Files Tab
            page.locator("a:has-text('Files'), button:has-text('Files')").first.click()
            wait_for_spinners(page, extra_delay=1.5)

            # Oldest Contract
            try:
                contract_rows = page.locator("div.studentfilerow").filter(has_text="Student Contract")
                if contract_rows.count() > 0:
                    with page.expect_download(timeout=30000) as d_info:
                        contract_rows.last.locator("a[href*='download_FileFromBlob']").first.click()
                    c_path = os.path.join(TEMP_DIR, f"{safe_name}_contract.pdf")
                    d_info.value.save_as(c_path)
                    student_files.append(c_path)
            except Exception as e:
                print(f"Contract error: {e}")

            # Newest Permit
            try:
                permit_rows = page.locator("div.studentfilerow").filter(has_text="Permit")
                if permit_rows.count() > 0:
                    with page.expect_download(timeout=30000) as d_info:
                        permit_rows.first.locator("a[href*='download_FileFromBlob']").first.click()
                    raw_p = os.path.join(TEMP_DIR, f"{safe_name}_raw_permit")
                    d_info.value.save_as(raw_p)
                    clean_p = os.path.join(TEMP_DIR, f"{safe_name}_permit.pdf")
                    normalize_permit_image(raw_p, clean_p)
                    student_files.append(clean_p)
            except Exception as e:
                print(f"Permit error: {e}")

            # Billing Receipt
            try:
                page.locator("a:has-text('Enrollment/Billing')").first.click()
                wait_for_spinners(page, extra_delay=1.5)
                b_wrap = page.locator("#billingtableid_wrapper")
                b_wrap.locator("a.btn.blue.btn-sm[data-toggle='dropdown']").first.click()
                time.sleep(0.5)

                with page.expect_popup(timeout=30000) as p_info:
                    page.locator("a[onclick*='GetReceiptofEnrollmentAndBillingFromGridRow']").first.click()
                r_page = p_info.value
                r_page.wait_for_load_state("domcontentloaded", timeout=30000)
                r_pdf = os.path.join(TEMP_DIR, f"{safe_name}_receipt.pdf")
                r_page.pdf(path=r_pdf, print_background=True)
                r_page.close()
                student_files.append(r_pdf)
            except Exception as e:
                print(f"Receipt error: {e}")

            # Class D Log
            try:
                navigate_sidebar(page, "Report Center", "SC Reports/Forms")
                page.locator("a[onclick*=\"WAStateForms_TempAuthForm_OpenModal('2')\"]").first.click()
                page.locator("input#txt_SCStateForms_TempAuthForm_SearchStudentByLastName").fill(last)
                page.locator("button#btn_WAStateForms_TempAuthForm_FetchStudentByLastName").first.click()
                s_select = page.locator("select#select_SCStateForms_StudentsList_TempAuthForm")
                s_select.wait_for(state="visible", timeout=25000)
                s_select.select_option(label=f"{last}, {first}")
                time.sleep(0.5)

                with page.expect_download(timeout=40000) as d_info:
                    page.locator("button#btn_SCStateForms_Download_TempAuthFrom").first.click()
                d_pdf = os.path.join(TEMP_DIR, f"{safe_name}_class_d.pdf")
                d_info.value.save_as(d_pdf)
                student_files.append(d_pdf)
            except Exception as e:
                print(f"Class D error: {e}")

            # Combine Packet
            if student_files:
                packet_path = os.path.join(TEMP_DIR, f"{safe_name}_packet.pdf")
                combine_documents_to_master(student_files, packet_path)
                metadata.append({
                    "name": full_name,
                    "files_count": len(student_files),
                    "packet_filename": f"{safe_name}_packet.pdf"
                })

        # Save metadata index for desktop app
        with open(os.path.join(TEMP_DIR, "manifest.json"), "w") as f:
            json.dump(metadata, f)

        browser.close()
        print("Scraping and compilation completed.")

if __name__ == "__main__":
    main()
