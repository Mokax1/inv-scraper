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
TARGET_GROUPS = {
    "BS203": "11 -K",   # Maritime Culture & Leadership
    "BS261": "02 -B",   # Ship Compasses & Auto Pilot
    "BS292": "06 -H",   # Maritime Law & IMO Conventions
    "BS213": "10 -J",   # Watch Keeping & Marine Communication
    "BS234": "04 -D",   # Terrestrial Navigation part II
    "BS222": "10 -K",   # Ship Stability
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
        header = f"📊 Registration Status Update: {matched_count}/{total} Available"
    else:
        header = f"📊 Registration Status Update: 0/{total} Available"

    if matched_count > 0:
        lines = [f"• {code}: Group {grp}" for code, grp in available_slots.items()]
        body = "\n".join(lines)
    else:
        body = "None of your target groups are available yet."

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
        print(f"[!] Telegram text notification failed: {e}")


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

            page.wait_for_timeout(3000)

            # 4. Click "Change Registered Courses"
            print("[*] Locating 'Change Registered Courses' button...")
            change_reg_btn = page.locator(
                "#ctl00_ContentPlaceHolder1_lbtn_changeReg, a:has-text('Change Registered Courses')"
            ).first

            change_reg_btn.wait_for(state="attached", timeout=20000)

            with page.expect_navigation(wait_until="domcontentloaded", timeout=35000):
                try:
                    change_reg_btn.click(force=True, timeout=5000)
                except Exception:
                    change_reg_btn.evaluate("el => el.click()")

            # 5. On the Registration Grid (frm_Register.aspx)
            print(f"[*] Landed on Registration Table: {page.url}")
            page.wait_for_selector("#ctl00_ContentPlaceHolder1_grdvw_courses", timeout=20000)

            rows = page.locator("#ctl00_ContentPlaceHolder1_grdvw_courses tr")
            total_rows = rows.count()
            print(f"[*] Total rows found in courses table: {total_rows}")

            available_target_slots = {}

            # Iterate through rows starting from index 1 (skip header)
            for i in range(1, total_rows):
                row = rows.nth(i)
                cells = row.locator("td")
                if cells.count() < 2:
                    continue

                code_text = cells.nth(0).inner_text().strip().replace("*", "")

                matched_target_code = None
                for target_code in TARGET_GROUPS.keys():
                    if target_code in code_text:
                        matched_target_code = target_code
                        break

                if matched_target_code:
                    target_group_str = TARGET_GROUPS[matched_target_code].replace(" ", "").upper()
                    
                    dropdown = row.locator("select[id*='drp_cls']")
                    if dropdown.count() > 0:
                        options = dropdown.locator("option").all_inner_texts()
                        cleaned_options = [opt.replace(" ", "").upper() for opt in options]

                        print(f"[*] {matched_target_code} dropdown options: {options}")

                        is_available = any(target_group_str in opt for opt in cleaned_options)
                        if is_available:
                            print(f"[!] FOUND: {matched_target_code} -> {TARGET_GROUPS[matched_target_code]}")
                            available_target_slots[matched_target_code] = TARGET_GROUPS[matched_target_code]

            # 6. Notifications
            # Send Telegram update on EVERY single run
            send_telegram_status(available_target_slots)

            # Trigger the phone call ONLY when ALL 6 courses are available
            if len(available_target_slots) == len(TARGET_GROUPS):
                print("[!] ALL 6/6 COURSES AVAILABLE! Triggering cellular call...")
                make_twilio_call()
            else:
                print(f"[i] {len(available_target_slots)}/{len(TARGET_GROUPS)} courses currently available. No call needed yet.")

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
