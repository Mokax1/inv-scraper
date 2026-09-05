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

    # 1. Telegram Text Message
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

    # 2. Telegram Voice Call
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
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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

            # Wait for fields to exist
            page.wait_for_selector(
                "#ctl00_ContentPlaceHolder1_UserName", timeout=15000
            )

            # Fill credentials
            page.locator("#ctl00_ContentPlaceHolder1_UserName").fill(REG_NUMBER)
            page.locator("#ctl00_ContentPlaceHolder1_Password").fill(PIN)
            page.wait_for_timeout(1000)

            # Submit Login using the exact input[type='image'] ID
            print("[*] Submitting login...")
            login_btn = page.locator("#ctl00_ContentPlaceHolder1_btn_login")

            with page.expect_navigation(
                wait_until="domcontentloaded", timeout=30000
            ):
                try:
                    login_btn.click(timeout=5000)
                except Exception:
                    login_btn.evaluate("el => el.click()")

            # 2. Choice Page -> Click "REGISTER MAJOR"
            print(f"[*] Landed on: {page.url}")
            major_locator = page.locator(
                "#ctl00_ContentPlaceHolder1_l_major, a:has-text('REGISTER"
                " MAJOR')"
            ).first
            major_locator.wait_for(state="attached", timeout=20000)

            with page.expect_navigation(
                wait_until="domcontentloaded", timeout=30000
            ):
                try:
                    major_locator.click(force=True, timeout=5000)
                except Exception:
                    major_locator.evaluate("el => el.click()")

            # 3. Menu Page -> Click "Online Registration"
            print(f"[*] Landed on: {page.url}")
            reg_locator = page.locator(
                "#ctl00_ContentPlaceHolder1_Lbtn_Reg,"
                " a:has-text('Online Registration')"
            ).first
            reg_locator.wait_for(state="attached", timeout=20000)

            try:
                reg_locator.click(force=True, timeout=5000)
            except Exception:
                reg_locator.evaluate("el => el.click()")

            # Wait for ASP.NET partial update / postback
            page.wait_for_timeout(4000)

            # 4. Check status
            current_url = page.url
            body_text = page.inner_text("body")

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

            if "frm_Menu.aspx" not in current_url or not is_blocked:
                print("[!] REGISTRATION IS OPEN!")
                send_alerts(f"Navigated to: {current_url}")
            else:
                print(
                    f"[-] Closed: '{error_text.strip() or 'لا يسمح بالتسجيل'}'"
                    " detected."
                )

        except Exception as err:
            print(f"[!] Error during execution: {err}")
            try:
                page.screenshot(path="debugcheck.png", full_page=True)
                print("[+] Saved debugcheck.png")
            except Exception as ss_err:
                print(f"[!] Screenshot capture failed: {ss_err}")
            sys.exit(1)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
