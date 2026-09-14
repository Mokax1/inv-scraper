import os
import sys
import urllib.parse
import requests
from twilio.rest import Client
from playwright.sync_api import sync_playwright

# Portal Credentials
REG_NUMBER = os.environ.get("AAST_REG_NUM")
PIN = os.environ.get("AAST_PIN")

# Alerts
CALLMEBOT_USER = os.environ.get("CALLMEBOT_USER")

# Twilio Credentials (API Key Pair)
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_API_KEY = os.environ.get("TWILIO_API_KEY")
TWILIO_API_SECRET = os.environ.get("TWILIO_API_SECRET")
TWILIO_FROM = os.environ.get("TWILIO_FROM_NUMBER")
MY_PHONE = os.environ.get("MY_PHONE_NUMBER")

# Hosted TwiML Bin URL
TWIML_BIN_URL = "https://handler.twilio.com/twiml/EH2af47328c7adc64103b682b874c70070"

# Target Course Groups (ignoring Leadership and PE)
# Format: Course Code -> (Group Number, Group Letter)
TARGET_GROUPS = {
    "BS203": ("11", "K"),   # Maritime Culture & Leadership
    "BS261": ("02", "B"),   # Ship Compasses & Auto Pilot
    "BS292": ("06", "H"),   # Maritime Law & IMO Conventions
    "BS213": ("10", "J"),   # Watch Keeping & Marine Communication
    "BS234": ("04", "D"),   # Terrestrial Navigation part II
    "BS222": ("10", "K"),   # Ship Stability
}


def send_telegram_status(available_slots):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    total = len(TARGET_GROUPS)
    matched_count = len(available_slots)

    if matched_count == total:
        header = f"🚨 FULL TARGET SCHEDULE AVAILABLE! ({matched_count}/{total}) 🚨"
    elif matched_count > 0:
        header = f"📊 Registration Update: {matched_count}/{total} Target Groups Open"
    else:
        header = f"📊 Registration Update: 0/{total} Target Groups Open"

    if matched_count > 0:
        lines = [f"• {code}: Group {grp}" for code, grp in available_slots.items()]
        body = "\n".join(lines)
    else:
        body = "None of your desired sections have open seats yet."

    message = (
        f"{header}\n\n"
        f"{body}\n\n"
        "Portal: https://alexreg.aast.edu/aastreg/"
    )

    encoded_text = urllib.parse.quote(message)
    text_url = f"https://api.callmebot.com/text.php?user={CALLMEBOT_USER}&text={encoded_text}"
    try:
        r = requests.get(text_url, timeout=15)
        print(f"[+] Telegram status update sent ({matched_count}/{total}) - Status: {r.status_code}")
    except Exception as e:
        print(f"[!] Telegram text failed: {e}")


def make_twilio_call():
    if TWILIO_API_KEY and TWILIO_API_SECRET and TWILIO_ACCOUNT_SID:
        try:
            client = Client(TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_ACCOUNT_SID)
            call = client.calls.create(
                url=TWIML_BIN_URL,
                to=MY_PHONE,
                from_=TWILIO_FROM,
            )
            print(f"[+] Twilio call dispatched successfully. Call SID: {call.sid}")
        except Exception as e:
            print(f"[!] Twilio call failed: {e}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        try:
            # 1. Login Page
            print("[*] Loading login page...")
            page.goto(
                "https://alexreg.aast.edu/aastreg/frm_login.aspx",
                wait_until="networkidle",
                timeout=30000,
            )

            page.wait_for_selector("#ctl00_ContentPlaceHolder1_UserName", timeout=15000)
            page.locator("#ctl00_ContentPlaceHolder1_UserName").fill(REG_NUMBER)
            page.locator("#ctl00_ContentPlaceHolder1_Password").fill(PIN)
            page.wait_for_timeout(1000)

            # Submit Login
            print("[*] Submitting login...")
            login_btn = page.locator("#ctl00_ContentPlaceHolder1_btn_login")
            with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
                try:
                    login_btn.click(timeout=5000)
                except Exception:
                    login_btn.evaluate("el => el.click()")

            # 2. Choice Page -> Click "REGISTER MAJOR"
            print(f"[*] Landed on: {page.url}")
            major_locator = page.locator(
                "#ctl00_ContentPlaceHolder1_l_major, a:has-text('REGISTER MAJOR')"
            ).first
            major_locator.wait_for(state="attached", timeout=20000)

            with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
                try:
                    major_locator.click(force=True, timeout=5000)
                except Exception:
                    major_locator.evaluate("el => el.click()")

            # 3. Menu Page -> Click "Online Registration"
            print(f"[*] Landed on: {page.url}")
            reg_locator = page.locator(
                "#ctl00_ContentPlaceHolder1_Lbtn_Reg, a:has-text('Online Registration')"
            ).first
            reg_locator.wait_for(state="attached", timeout=20000)

            try:
                reg_locator.click(force=True, timeout=5000)
            except Exception:
                reg_locator.evaluate("el => el.click()")

            # Wait for DOM transition/render
            page.wait_for_timeout(4000)

            # 4. Handle Navigation to Registration Grid
            grid_locator = page.locator("#ctl00_ContentPlaceHolder1_grdvw_courses")
            if grid_locator.count() == 0:
                change_reg_btn = page.locator(
                    "#ctl00_ContentPlaceHolder1_lbtn_changeReg, a:has-text('Change Registered Courses')"
                ).first
                if change_reg_btn.is_visible():
                    print("[*] Clicking 'Change Registered Courses' button...")
                    try:
                        change_reg_btn.click(force=True, timeout=5000)
                    except Exception:
                        change_reg_btn.evaluate("el => el.click()")
                    page.wait_for_timeout(4000)

            print(f"[*] On registration view: {page.url}")
            page.wait_for_selector("#ctl00_ContentPlaceHolder1_grdvw_courses", timeout=20000)

            # 5. Native Browser Evaluation to Extract and Match Exact Options
            print("[*] Extracting course rows directly from DOM...")
            course_data = page.evaluate("""() => {
                const table = document.querySelector("#ctl00_ContentPlaceHolder1_grdvw_courses");
                if (!table) return [];
                
                const rows = Array.from(table.querySelectorAll("tr"));
                const result = [];
                
                // Skip header row
                for (let i = 1; i < rows.length; i++) {
                    const cells = rows[i].querySelectorAll("td");
                    if (cells.length < 8) continue;
                    
                    const code = cells[0].innerText.trim();
                    const groupNum = cells[5].innerText.trim();
                    const groupLetter = cells[6].innerText.trim();
                    
                    const select = cells[7].querySelector("select");
                    let options = [];
                    let selectedText = "";
                    
                    if (select) {
                        options = Array.from(select.options).map(o => o.text.trim());
                        selectedText = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text.trim() : "";
                    }
                    
                    result.push({
                        code: code,
                        currentGroupNum: groupNum,
                        currentGroupLetter: groupLetter,
                        selectedText: selectedText,
                        options: options
                    });
                }
                return result;
            }""")

            available_target_slots = {}

            for item in course_data:
                raw_code = item["code"].replace("*", "").strip()
                
                # Check if this row is one of our target courses
                matched_target_code = None
                for target_code in TARGET_GROUPS.keys():
                    if target_code in raw_code:
                        matched_target_code = target_code
                        break

                if matched_target_code:
                    req_num, req_letter = TARGET_GROUPS[matched_target_code]
                    req_num_unpadded = req_num.lstrip("0")
                    
                    options = item["options"]
                    selected_text = item["selectedText"]
                    curr_num = item["currentGroupNum"]
                    curr_letter = item["currentGroupLetter"]

                    print(f"\n[*] Course: {matched_target_code} (Target: {req_num}-{req_letter})")
                    print(f"    Current Row Display: Group {curr_num} {curr_letter}")
                    print(f"    Selected in Dropdown: '{selected_text}'")
                    print(f"    Available Options in Dropdown: {options}")

                    # 1. Check if the course is already currently assigned to this target group
                    is_currently_enrolled = (
                        (curr_num == req_num or curr_num == req_num_unpadded) and 
                        (curr_letter.upper() == req_letter.upper())
                    )

                    # 2. Check if the target section is present in the dropdown options
                    is_in_dropdown = False
                    for opt in options:
                        opt_upper = opt.upper()
                        # Matches patterns like "11 -K", "11-K", "11 K", or "11 - K"
                        has_num = req_num in opt_upper or req_num_unpadded in opt_upper
                        has_letter = f"-{req_letter}" in opt_upper or f" {req_letter}" in opt_upper or f"- {req_letter}" in opt_upper
                        if has_num and has_letter:
                            is_in_dropdown = True
                            break

                    if is_currently_enrolled or is_in_dropdown:
                        display_str = f"{req_num}-{req_letter}"
                        print(f"    => [MATCH FOUND] Section {display_str} is available!")
                        available_target_slots[matched_target_code] = display_str
                    else:
                        print(f"    => [NOT FOUND] Section {req_num}-{req_letter} is full.")

            # 6. Notifications
            # Text update every run with breakdown
            send_telegram_status(available_target_slots)

            # Voice call ONLY when all 6 sections are open simultaneously
            if len(available_target_slots) == len(TARGET_GROUPS):
                print("[!] ALL 6/6 SECTIONS OPEN! Triggering cellular call...")
                make_twilio_call()
            else:
                print(f"\n[i] Status: {len(available_target_slots)}/{len(TARGET_GROUPS)} available. No call needed yet.")

        except Exception as err:
            print(f"[!] Error during execution: {err}")
            try:
                page.screenshot(path="debugcheck.png", full_page=True)
                print("[+] Saved debugcheck.png")
            except Exception:
                pass
            sys.exit(1)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
