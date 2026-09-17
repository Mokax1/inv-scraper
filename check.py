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

# Target group for Ship Stability
TARGET_STABILITY_NUM = "10"
TARGET_STABILITY_LETTER = "K"


def send_telegram_status(message_text):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    encoded_text = urllib.parse.quote(message_text)
    text_url = f"https://api.callmebot.com/text.php?user={CALLMEBOT_USER}&text={encoded_text}"
    try:
        r = requests.get(text_url, timeout=15)
        print(f"[+] Telegram update sent - Status: {r.status_code}")
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
            # 1. Login
            print("[*] Loading login page...")
            page.goto("https://alexreg.aast.edu/aastreg/frm_login.aspx", wait_until="networkidle", timeout=30000)

            page.wait_for_selector("#ctl00_ContentPlaceHolder1_UserName", timeout=15000)
            page.locator("#ctl00_ContentPlaceHolder1_UserName").fill(REG_NUMBER)
            page.locator("#ctl00_ContentPlaceHolder1_Password").fill(PIN)
            page.wait_for_timeout(1000)

            print("[*] Submitting login...")
            login_btn = page.locator("#ctl00_ContentPlaceHolder1_btn_login")
            with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
                try:
                    login_btn.click(timeout=5000)
                except Exception:
                    login_btn.evaluate("el => el.click()")

            # 2. Choice Page -> REGISTER MAJOR
            print(f"[*] Landed on: {page.url}")
            major_locator = page.locator("#ctl00_ContentPlaceHolder1_l_major, a:has-text('REGISTER MAJOR')").first
            major_locator.wait_for(state="attached", timeout=20000)

            with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
                try:
                    major_locator.click(force=True, timeout=5000)
                except Exception:
                    major_locator.evaluate("el => el.click()")

            # 3. Menu Page -> Online Registration
            print(f"[*] Landed on: {page.url}")
            reg_locator = page.locator("#ctl00_ContentPlaceHolder1_Lbtn_Reg, a:has-text('Online Registration')").first
            reg_locator.wait_for(state="attached", timeout=20000)

            try:
                reg_locator.click(force=True, timeout=5000)
            except Exception:
                reg_locator.evaluate("el => el.click()")

            page.wait_for_timeout(4000)

            # 4. Click "Change Registered Courses"
            print("[*] Checking for 'Change Registered Courses' button...")
            change_reg_btn = page.locator("#ctl00_ContentPlaceHolder1_lbtn_changeReg, a:has-text('Change Registered Courses')").first
            change_reg_btn.wait_for(state="attached", timeout=15000)
            print("[*] Clicking 'Change Registered Courses'...")

            try:
                change_reg_btn.click(force=True, timeout=5000)
            except Exception:
                change_reg_btn.evaluate("el => el.click()")

            page.wait_for_timeout(3000)

            print("[*] Waiting for table controls...")
            page.wait_for_selector("#ctl00_ContentPlaceHolder1_grdvw_courses select", state="visible", timeout=25000)
            page.wait_for_timeout(1000)

            stability_found = False
            stability_already_registered = False
            matched_stability_val = None
            ship_select_box = None

            # =========================================================================
            # CHECK: Ship Stability (Target: 10-K)
            # =========================================================================
            print(f"\n[*] Checking Ship Stability (Target: {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER})...")
            ship_row = page.locator("#ctl00_ContentPlaceHolder1_grdvw_courses tr:has(td:has-text('Ship Stability'))").first

            if ship_row.count() > 0:
                ship_select_box = ship_row.locator("select").first
                if ship_select_box.count() > 0:
                    # 1. Check ONLY the currently active/selected option in the dropdown
                    currently_selected_text = ship_select_box.evaluate("el => el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''").upper()
                    print(f"    Current Active Selection -> {currently_selected_text}")

                    if TARGET_STABILITY_NUM in currently_selected_text and TARGET_STABILITY_LETTER in currently_selected_text:
                        print("    => [OK] Ship Stability 10-K is ALREADY registered.")
                        stability_already_registered = True
                        stability_found = True
                    else:
                        # 2. Inspect available options to see if 10-K has opened up
                        options = ship_select_box.locator("option").all()
                        for opt in options:
                            txt = opt.inner_text().upper()
                            val = opt.get_attribute("value") or ""
                            if TARGET_STABILITY_NUM in txt and TARGET_STABILITY_LETTER in txt:
                                matched_stability_val = val
                                stability_found = True
                                print(f"    => [FOUND] Group {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER} is available!")
                                break

                    if not stability_found:
                        print(f"    => [UNAVAILABLE] {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER} not in Ship Stability options.")
            else:
                print("[-] Ship Stability row not found.")

            # =========================================================================
            # ALERTS & EXECUTION
            # =========================================================================
            if stability_already_registered:
                send_telegram_status("✅ Ship Stability (10-K) is already confirmed & registered.")
                print("[i] Nothing to do. Already registered.")

            elif stability_found and matched_stability_val and ship_select_box:
                # 1. Alert immediately before clicking
                alert_msg = (
                    "🚨 SHIP STABILITY 10-K IS OPEN! 🚨\n\n"
                    "Automating enrollment and confirmation now...\n"
                    "Portal: https://alexreg.aast.edu/aastreg/"
                )
                print("[!] Slot open! Sending Telegram update & placing call...")
                send_telegram_status(alert_msg)
                make_twilio_call()

                # 2. Select 10-K in the dropdown
                print(f"[*] Selecting {TARGET_STABILITY_NUM}-{TARGET_STABILITY_LETTER} in dropdown...")
                ship_select_box.select_option(value=matched_stability_val)
                page.wait_for_timeout(2000)

                # 3. Confirm Registration
                print("[*] Clicking 'Confirm Registration'...")
                confirm_btn = page.locator("#ctl00_ContentPlaceHolder1_lbtn_confirm, a:has-text('Confirm Registration')").first
                confirm_btn.wait_for(state="attached", timeout=10000)

                try:
                    confirm_btn.click(force=True, timeout=5000)
                except Exception:
                    confirm_btn.evaluate("el => el.click()")

                print("[*] Waiting for final registration confirmation modal...")
                page.wait_for_selector("#TB_window, font:has-text('The final registration has been implemented')", timeout=20000)
                page.screenshot(path="stability_confirmed_success.png", full_page=True)
                print("[+] Saved stability_confirmed_success.png")
                print("[+] Ship Stability registered & confirmed successfully!")

                send_telegram_status("🎉 ENROLLMENT COMPLETE: Ship Stability (10-K) is registered and confirmed!")

            else:
                send_telegram_status("📊 Registration Update: Ship Stability (10-K) not open yet.")

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
