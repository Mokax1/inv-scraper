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
# Normalized format: (Code -> Group Letter/Number)
TARGET_GROUPS = {
    "BS203": "11K",   # Maritime Culture & Leadership
    "BS261": "02B",   # Ship Compasses & Auto Pilot
    "BS292": "06H",   # Maritime Law & IMO Conventions
    "BS213": "10J",   # Watch Keeping & Marine Communication
    "BS234": "04D",   # Terrestrial Navigation part II
    "BS222": "10K",   # Ship Stability
}


def clean_str(val: str) -> str:
    """Removes spaces, hyphens, and asterisks for robust comparisons."""
    return val.replace(" ", "").replace("-", "").replace("*", "").upper()


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
            # Check if grid is ALREADY present on screen
            grid_locator = page.locator("#ctl00_ContentPlaceHolder1_grdvw_courses")
            if grid_locator.count() == 0:
                # If grid is not yet rendered, check for "Change Registered Courses" button
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

            # Wait for course table
            print(f"[*] On registration view: {page.url}")
            page.wait_for_selector("#ctl00_ContentPlaceHolder1_grdvw_courses", timeout=20000)

            # 5. Scan Course Table Rows
            rows = page.locator("#ctl00_ContentPlaceHolder1_grdvw_courses tr")
            total_rows = rows.count()
            print(f"[*] Scanning {total_rows} table rows...")

            available_target_slots = {}

            for i in range(1, total_rows):
                row = rows.nth(i)
                cells = row.locator("td")
                if cells.count() < 2:
                    continue

                raw_code = cells.nth(0).inner_text().strip()
                cleaned_row_code = clean_str(raw_code)

                # Match against target courses
                matched_target = None
                for target_code in TARGET_GROUPS.keys():
                    if clean_str(target_code) in cleaned_row_code:
                        matched_target = target_code
                        break

                if matched_target:
                    target_group = TARGET_GROUPS[matched_target]  # e.g., "11K"
                    dropdown = row.locator("select[id*='drp_cls']")

                    if dropdown.count() > 0:
                        options = dropdown.locator("option").all_inner_texts()
                        cleaned_opts = [clean_str(opt) for opt in options]

                        print(f"[*] {matched_target}: looking for '{target_group}' in options -> {options}")

                        # Check if target group appears in any of the available options
                        if any(target_group in opt for opt in cleaned_opts):
                            print(f"[!] Target group {target_group} is AVAILABLE for {matched_target}!")
                            available_target_slots[matched_target] = target_group
                        else:
                            print(f"[-] Target group {target_group} not in available list for {matched_target}.")

            # 6. Notifications
            # Text update every run with breakdown
            send_telegram_status(available_target_slots)

            # Voice call ONLY when all 6 sections are open simultaneously
            if len(available_target_slots) == len(TARGET_GROUPS):
                print("[!] ALL 6/6 SECTIONS OPEN! Triggering cellular call...")
                make_twilio_call()
            else:
                print(f"[i] Status: {len(available_target_slots)}/{len(TARGET_GROUPS)} available. No call needed yet.")

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
