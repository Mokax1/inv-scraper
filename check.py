import os
import sys
import urllib.parse
import requests
from playwright.sync_api import sync_playwright

REG_NUMBER = os.environ.get("AAST_REG_NUM")
PIN = os.environ.get("AAST_PIN")
CALLMEBOT_USER = os.environ.get("CALLMEBOT_USER")


def send_alerts(status_info):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    # 1. Telegram Text Notification
    text_message = (
        f"🚨 REGISTRATION IS OPEN! 🚨\n\nStatus: {status_info}\nGo register now: "
        "https://alexreg.aast.edu/aastreg/"
    )
    encoded_text = urllib.parse.quote(text_message)
    text_url = f"https://api.callmebot.com/text.php?user={CALLMEBOT_USER}&text={encoded_text}"
    try:
        r = requests.get(text_url, timeout=15)
        print(f"[+] Text alert dispatched (Status: {r.status_code})")
    except Exception as e:
        print(f"[!] Text alert failed: {e}")

    # 2. Phone Call via CallMeBot
    call_msg = urllib.parse.quote(
        "AAST registration is now open! Log in and pick your courses"
        " immediately."
    )
    call_url = f"http://api.callmebot.com/start.php?user={CALLMEBOT_USER}&text={call_msg}&lang=en-US-Standard-C&rpt=2"
    try:
        r = requests.get(call_url, timeout=15)
        print(f"[+] Voice call triggered (Status: {r.status_code})")
    except Exception as e:
        print(f"[!] Voice call failed: {e}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            # 1. Login Page
            print("[*] Loading login page...")
            page.goto(
                "https://alexreg.aast.edu/aastreg/frm_login.aspx",
                wait_until="domcontentloaded",
                timeout=30000,
            )

            # Fill credentials
            page.wait_for_selector(
                "#ctl00_ContentPlaceHolder1_UserName", timeout=15000
            )
            page.locator("#ctl00_ContentPlaceHolder1_UserName").fill(REG_NUMBER)
            page.locator("#ctl00_ContentPlaceHolder1_Password").fill(PIN)

            # Submit login
            print("[*] Submitting login...")
            page.locator(
                "#ctl00_ContentPlaceHolder1_btn_login, a:has-text('Login'),"
                " input[value='Login']"
            ).first.click()

            # 2. Choice Page -> Click "REGISTER MAJOR"
            print("[*] Waiting for frm_choice.aspx...")
            page.wait_for_url("**/frm_choice.aspx", timeout=25000)
            page.wait_for_selector(
                "#ctl00_ContentPlaceHolder1_l_major", timeout=15000
            )
            page.locator("#ctl00_ContentPlaceHolder1_l_major").click()

            # 3. Menu Page -> Click "Online Registration"
            print("[*] Waiting for frm_Menu.aspx...")
            page.wait_for_url("**/frm_Menu.aspx", timeout=25000)
            page.wait_for_selector(
                "#ctl00_ContentPlaceHolder1_Lbtn_Reg", timeout=15000
            )
            page.locator("#ctl00_ContentPlaceHolder1_Lbtn_Reg").click()

            # Brief wait for postback/DOM update
            page.wait_for_timeout(3500)

            # 4. Evaluation
            current_url = page.url
            body_text = page.inner_text("body")

            # Check if red error message exists
            lbl_msg_locator = page.locator("#ctl00_ContentPlaceHolder1_lbl_msg")
            error_text = ""
            if lbl_msg_locator.count() > 0:
                error_text = lbl_msg_locator.first.inner_text()

            is_blocked = (
                "التسجيل غير متاح" in error_text
                or "لا يسمح بالتسجيل" in error_text
                or "التسجيل غير متاح" in body_text
                or "لا يسمح بالتسجيل" in body_text
            )

            # Open if navigated away from frm_Menu OR the block text is absent
            if "frm_Menu.aspx" not in current_url or not is_blocked:
                print("[!] REGISTRATION IS OPEN!")
                send_alerts(f"Navigated to {current_url}")
            else:
                print(
                    f"[-] Closed: '{error_text.strip() or 'لا يسمح بالتسجيل'}'"
                    " detected."
                )

        except Exception as err:
            print(f"[!] Error during execution: {err}")
            sys.exit(1)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
