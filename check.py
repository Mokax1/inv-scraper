import os
import sys
import urllib.parse
import requests
from playwright.sync_api import sync_playwright

REG_NUMBER = os.environ.get("AAST_REG_NUM")
PIN = os.environ.get("AAST_PIN")
CALLMEBOT_USER = os.environ.get("CALLMEBOT_USER")


def send_alerts(status_url):
    if not CALLMEBOT_USER:
        print("[!] CALLMEBOT_USER secret is missing.")
        return

    # 1. Send Text Notification via CallMeBot
    text_message = (
        f"🚨 REGISTRATION IS OPEN! 🚨\n\nPage: {status_url}\nGo register now: "
        "https://alexreg.aast.edu/aastreg/"
    )
    encoded_text = urllib.parse.quote(text_message)
    text_url = f"https://api.callmebot.com/text.php?user={CALLMEBOT_USER}&text={encoded_text}"
    try:
        r = requests.get(text_url, timeout=15)
        print(f"[+] Text alert sent (Status: {r.status_code})")
    except Exception as e:
        print(f"[!] Text alert failed: {e}")

    # 2. Trigger Phone Call via CallMeBot
    call_msg = urllib.parse.quote(
        "AAST registration is now open! Log in and pick your courses"
        " immediately."
    )
    call_url = f"https://api.callmebot.com/start.php?user={CALLMEBOT_USER}&text={call_msg}&lang=en-US-Standard-C&rpt=2"
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
            # 1. Login
            page.goto(
                "https://alexreg.aast.edu/aastreg/frm_login.aspx", timeout=30000
            )
            page.locator("input[name*='Txt_RegNum']").fill(REG_NUMBER)
            page.locator("input[name*='Txt_PinNo']").fill(PIN)
            page.locator("input[name*='Btn_Login']").click()

            # 2. Choice page -> Register Major
            page.wait_for_url("**/frm_choice.aspx", timeout=20000)
            page.locator("input[name*='Btn_RegMajor']").click()

            # 3. Menu page -> Online Registration
            page.wait_for_url("**/frm_Menu.aspx", timeout=20000)
            page.locator("a:has-text('Online Registration')").click()
            page.wait_for_timeout(3000)

            # 4. Evaluation
            current_url = page.url
            body_text = page.inner_text("body")
            is_blocked = (
                "التسجيل غير متاح" in body_text
                or "لا يسمح بالتسجيل" in body_text
            )

            if "frm_Menu.aspx" not in current_url or not is_blocked:
                print("[!] REGISTRATION OPEN!")
                send_alerts(current_url)
            else:
                print("[-] Still closed. 'لا يسمح بالتسجيل' detected.")

        except Exception as err:
            print(f"[!] Error during run: {err}")
            sys.exit(1)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
