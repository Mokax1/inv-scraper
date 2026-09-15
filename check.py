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

# Target groups
TARGET_STABILITY_NUM = "09"
TARGET_STABILITY_LETTER = "J"

TARGET_LAW_NUM = "12"
TARGET_LAW_LETTER = "L"

TOTAL_MONITORED = 2


def send_telegram_status(available_slots):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    matched_count = len(available_slots)
    if matched_count > 0:
        header = f"🚨 TARGET SLOT FOUND & SELECTED! ({matched_count}/{TOTAL_MONITORED}) 🚨"
        lines = [f"• {name}: Group {grp}" for name, grp in available_slots.items()]
        body = "\n".join(lines)
    else:
        header = f"📊 Registration Update: 0/{TOTAL_MONITORED} Open"
        body = "Neither target group was found."

    message = (
        f"{header}\n\n"
        f"{body}\n\n"
        "Portal: https://alexreg.aast.edu/aastreg/"
    )

    encoded_text = urllib.parse.quote(message)
    text_url = f"https://api.callmebot.com/text.php?user={CALLMEBOT_USER}&text={encoded_text}"
    try:
        r = requests.get(text_url, timeout=15)
        print(f"[+] Telegram status update sent ({matched_count}/{TOTAL_MONITORED}) - Status: {r.status_code}")
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

            # 4. Click "Change Registered Courses" to unlock table
            print("[*] Checking for 'Change Registered Courses' button...")
            change_reg_btn = page.locator(
                "#ctl00_ContentPlaceHolder1_lbtn_changeReg, a:has-text('Change Registered Courses')"
            ).first

            change_reg_btn.wait_for(state="attached", timeout=15000)
            print("[*] Clicking 'Change Registered Courses'...")

            try:
                change_reg_btn.click(force=True, timeout=5000)
            except Exception:
                change_reg_btn.evaluate("el => el.click()")

            page.wait_for_timeout(3000)
            page.screenshot(path="step1_after_change_reg.png", full_page=True)

            print("[*] Waiting for table controls...")
            page.wait_for_selector(
                "#ctl00_ContentPlaceHolder1_grdvw_courses select",
                state="visible",
                timeout=25000,
            )
            page.wait_for_timeout(1000)
            page.screenshot(path="step2_editable_table.png", full_page=True)

            available_target_slots = {}

            # =========================================================================
            # Target 1: Ship Stability (Select from Table Dropdown)
            # =========================================================================
            print(f"\n[*] Checking Subject 1: Ship Stability (Target: {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER})...")
            row_selector = "#ctl00_ContentPlaceHolder1_grdvw_courses tr:has(td:has-text('Ship Stability'))"
            ship_row = page.locator(row_selector).first

            if ship_row.count() > 0:
                select_box = ship_row.locator("select").first
                if select_box.count() > 0:
                    options_elements = select_box.locator("option").all()
                    matched_val = None

                    for opt in options_elements:
                        txt = opt.inner_text().upper()
                        val = opt.get_attribute("value") or ""
                        if TARGET_STABILITY_NUM in txt and TARGET_STABILITY_LETTER in txt:
                            matched_val = val
                            break

                    if matched_val is not None:
                        print(f"    => [MATCH FOUND] Selecting group {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER}...")
                        select_box.select_option(value=matched_val)
                        page.wait_for_timeout(2000)
                        available_target_slots["Ship Stability"] = f"{TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER}"
                    else:
                        print(f"    => [UNAVAILABLE] {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER} not in options.")
            else:
                print("[-] Ship Stability row not found.")

            # =========================================================================
            # Target 2: Maritime Law (Select from Top Dropdown)
            # =========================================================================
            print(f"\n[*] Checking Subject 2: Maritime Law (Target: {TARGET_LAW_NUM}-{TARGET_LAW_LETTER})...")
            course_ddl = page.locator("#ctl00_ContentPlaceHolder1_ddl_crsname")
            course_ddl.wait_for(state="visible", timeout=10000)

            print("[*] Choosing 'Maritime Law & IMO Conventions'...")
            course_ddl.select_option(label="Maritime Law & IMO Conventions              (BS292*    )")
            page.wait_for_timeout(2500)
            page.screenshot(path="step3_maritime_law_selected.png", full_page=True)

            grp_ddl = page.locator("#ctl00_ContentPlaceHolder1_ddl_grp")
            grp_ddl.wait_for(state="visible", timeout=10000)

            grp_options_elements = grp_ddl.locator("option").all()
            matched_law_val = None

            for opt in grp_options_elements:
                txt = opt.inner_text().upper()
                val = opt.get_attribute("value") or ""
                if TARGET_LAW_NUM in txt and TARGET_LAW_LETTER in txt:
                    matched_law_val = val
                    break

            if matched_law_val is not None:
                print(f"    => [MATCH FOUND] Selecting group {TARGET_LAW_NUM}-{TARGET_LAW_LETTER}...")
                grp_ddl.select_option(value=matched_law_val)
                page.wait_for_timeout(2000)
                available_target_slots["Maritime Law"] = f"{TARGET_LAW_NUM}-{TARGET_LAW_LETTER}"
            else:
                print(f"    => [UNAVAILABLE] {TARGET_LAW_NUM}-{TARGET_LAW_LETTER} not in group options.")

            # Final screenshot after selecting options
            page.screenshot(path="step4_selected_groups.png", full_page=True)
            print("[+] Saved step4_selected_groups.png")

            # =========================================================================
            # Notifications & Trigger
            # =========================================================================
            send_telegram_status(available_target_slots)

            if len(available_target_slots) > 0:
                print(f"[!] {len(available_target_slots)} target slot(s) selected! Placing Twilio voice call...")
                make_twilio_call()
            else:
                print("\n[i] No target slots selected.")

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
