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

# Target Course Dropdown Mapping:
# Selector ID -> (Course Name, Target Group Number, Target Letter Value)
TARGET_MAP = {
    "ctl00_ContentPlaceHolder1_grdvw_courses_ctl04_drp_cls": ("BS292 Maritime Law", "06", "H"),
    "ctl00_ContentPlaceHolder1_grdvw_courses_ctl05_drp_cls": ("BS203 Maritime Culture", "11", "K"),
    "ctl00_ContentPlaceHolder1_grdvw_courses_ctl06_drp_cls": ("BS234 Terr Navigation", "04", "D"),
    "ctl00_ContentPlaceHolder1_grdvw_courses_ctl07_drp_cls": ("BS213 Watch Keeping", "10", "J"),
    "ctl00_ContentPlaceHolder1_grdvw_courses_ctl08_drp_cls": ("BS222 Ship Stability", "10", "K"),
    "ctl00_ContentPlaceHolder1_grdvw_courses_ctl09_drp_cls": ("BS261 Ship Compasses", "02", "B"),
}


def send_telegram_status(available_slots):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    total = len(TARGET_MAP)
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

            # 5. Direct Selector Check
            available_target_slots = {}

            print("\n[*] Inspecting target course dropdowns...")
            for element_id, (course_name, req_num, req_letter) in TARGET_MAP.items():
                select_locator = page.locator(f"#{element_id}")
                
                if select_locator.count() == 0:
                    print(f"[-] Dropdown #{element_id} not found on page.")
                    continue

                # Query options directly from this dropdown element
                options_data = select_locator.evaluate("""el => {
                    return Array.from(el.options).map(opt => ({
                        value: opt.value ? opt.value.trim().toUpperCase() : "",
                        text: opt.text ? opt.text.trim().toUpperCase() : ""
                    }));
                }""")

                req_target_display = f"{req_num}-{req_letter}"
                unpadded_num = req_num.lstrip("0")

                is_available = False
                matched_option_text = ""

                for opt in options_data:
                    val = opt["value"]
                    txt = opt["text"]

                    # Check if letter matches value and number exists in text
                    matches_val = (val == req_letter.upper())
                    matches_num = (req_num in txt) or (unpadded_num in txt)

                    if matches_val and matches_num:
                        is_available = True
                        matched_option_text = txt
                        break

                all_texts = [o["text"] for o in options_data]
                print(f"[*] {course_name} (Target: {req_target_display}):")
                print(f"    Options available: {all_texts}")

                if is_available:
                    print(f"    => [MATCH FOUND] {matched_option_text}")
                    available_target_slots[course_name] = req_target_display
                else:
                    print(f"    => [FULL] Target {req_target_display} not available.")

            # 6. Notifications
            send_telegram_status(available_target_slots)

            if len(available_target_slots) == len(TARGET_MAP):
                print("[!] ALL 6/6 SECTIONS OPEN! Triggering cellular call...")
                make_twilio_call()
            else:
                print(f"\n[i] Status: {len(available_target_slots)}/{len(TARGET_MAP)} available. No call needed yet.")

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
