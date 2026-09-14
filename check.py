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

# Target Courses & Group Codes
TARGET_COURSES = {
    "Maritime Law & IMO Conventions": ("06", "H"),
    "Maritime Culture & Leadership": ("11", "K"),
    "Terrestrial Navigation part II": ("04", "D"),
    "Watch Keeping & Marine Communication": ("10", "J"),
    "Ship Stability": ("10", "K"),
    "Ship Compasses & Auto Pilot": ("02", "B"),
}


def send_telegram_status(available_slots):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    total = len(TARGET_COURSES)
    matched_count = len(available_slots)

    if matched_count == total:
        header = f"🚨 FULL TARGET SCHEDULE AVAILABLE! ({matched_count}/{total}) 🚨"
    elif matched_count > 0:
        header = f"📊 Registration Update: {matched_count}/{total} Target Groups Open"
    else:
        header = f"📊 Registration Update: 0/{total} Target Groups Open"

    if matched_count > 0:
        lines = [f"• {name}: Group {grp}" for name, grp in available_slots.items()]
        body = "\n".join(lines)
    else:
        body = "None of your target groups are open yet."

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

            page.wait_for_timeout(4000)

            # 4. Explicitly Click "Change Registered Courses" to unlock dropdowns
            print("[*] Checking for 'Change Registered Courses' button...")
            change_reg_btn = page.locator(
                "#ctl00_ContentPlaceHolder1_lbtn_changeReg, a:has-text('Change Registered Courses')"
            ).first

            # Wait for button to be available
            change_reg_btn.wait_for(state="attached", timeout=15000)
            print("[*] Clicking 'Change Registered Courses' to switch table to editable mode...")
            
            try:
                change_reg_btn.click(force=True, timeout=5000)
            except Exception:
                change_reg_btn.evaluate("el => el.click()")

            # 5. Wait for the editable dropdowns to actually render inside the table
            print("[*] Waiting for dropdowns (<select>) to populate...")
            page.wait_for_selector(
                "#ctl00_ContentPlaceHolder1_grdvw_courses select", 
                state="visible", 
                timeout=25000
            )
            page.wait_for_timeout(2000)

            # 6. Direct Selector Check using Row Parent Text
            available_target_slots = {}
            print("\n[*] Inspecting courses by Subject Name...")

            for subject_name, (target_num, target_letter) in TARGET_COURSES.items():
                target_str = f"{target_num}-{target_letter}"
                unpadded_num = target_num.lstrip("0")

                # Locate the specific row that contains this subject's exact td text
                row_selector = f"#ctl00_ContentPlaceHolder1_grdvw_courses tr:has(td:has-text('{subject_name}'))"
                row = page.locator(row_selector).first

                if row.count() == 0:
                    print(f"[-] Row for '{subject_name}' was not found.")
                    continue

                select_box = row.locator("select").first
                if select_box.count() == 0:
                    print(f"[-] Dropdown in row for '{subject_name}' not found.")
                    continue

                # Read all option texts directly
                options = select_box.locator("option").all_inner_texts()
                print(f"[*] {subject_name} (Target: {target_str}):")
                print(f"    Available Dropdown Options -> {options}")

                is_available = False
                for opt in options:
                    opt_upper = opt.upper()
                    # Check both padded ("02") and unpadded ("2") alongside target letter ("B")
                    has_num = target_num in opt_upper or unpadded_num in opt_upper
                    has_letter = target_letter.upper() in opt_upper
                    if has_num and has_letter:
                        is_available = True
                        break

                if is_available:
                    print(f"    => [MATCH] Found slot for {target_str}!")
                    available_target_slots[subject_name] = target_str
                else:
                    print(f"    => [UNAVAILABLE] {target_str} not in dropdown.")

            # 7. Notifications
            send_telegram_status(available_target_slots)

            # Trigger Twilio voice call when all 6 match
            if len(available_target_slots) == len(TARGET_COURSES):
                print("[!] ALL 6/6 TARGET SLOTS AVAILABLE! Placing Twilio phone call...")
                make_twilio_call()
            else:
                print(f"\n[i] Status: {len(available_target_slots)}/{len(TARGET_COURSES)} available.")

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
