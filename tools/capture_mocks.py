"""モック画像を撮影する: python tools/capture_mocks.py

別のDBファイルでアプリを 2 つ起動し(通常 / FAIL_TX=1)、実際の画面操作を Chrome で再現して mock/ に保存する。
前提: pip install playwright(ブラウザは PC にインストール済みの Chrome を使う)
"""
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "mock"
OUT.mkdir(exist_ok=True)
TMP = Path(tempfile.mkdtemp(prefix="gate5-mock-"))
PORT_MAIN, PORT_FAIL = 3100, 3101


def start_server(port, db_name, extra_env=None):
    env = {**os.environ, "PORT": str(port), "DB_PATH": str(TMP / db_name), **(extra_env or {})}
    subprocess.run(["node", "src/seed.js"], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    proc = subprocess.Popen(["node", "app.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://localhost:{port}/login?user_id=1", timeout=1)
            return proc, TMP / db_name
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("サーバーが起動しません")


def next_weekday(days_ahead=1):
    d = date.today() + timedelta(days=days_ahead)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def fmt(d):
    return d.strftime("%Y/%m/%d")


def main():
    main_proc, main_db = start_server(PORT_MAIN, "main.sqlite")
    fail_proc, _ = start_server(PORT_FAIL, "fail.sqlite", {"FAIL_TX": "1"})
    base = f"http://localhost:{PORT_MAIN}"
    due = fmt(next_weekday(1))
    saved = []

    def shot(page, name):
        path = OUT / name
        page.screenshot(path=str(path), full_page=True)
        saved.append(name)
        print("saved", name)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)

        def new_page(user, port=PORT_MAIN):
            ctx = browser.new_context(viewport={"width": 760, "height": 520}, locale="ja-JP")
            ctx.add_cookies([{"name": "user_id", "value": str(user), "url": f"http://localhost:{port}"}])
            return ctx.new_page()

        def apply_form(page, asset_no, due_text, purpose, port=PORT_MAIN):
            """申請画面を開き、資産番号の機種・返却予定日・利用目的を入力する"""
            page.goto(f"http://localhost:{port}/lendings/new")
            page.select_option("#device_id", label=device_label(page, asset_no))
            page.fill("#due_date", due_text)
            page.fill("#purpose", purpose)

        def device_label(page, asset_no):
            return page.locator("#device_id option", has_text=asset_no).first.inner_text()

        # 01 正常時:貸出完了(山田 → PC-0001)
        u1 = new_page(1)
        apply_form(u1, "PC-0001", due, "出張")
        u1.click("#submit")
        u1.click("#commit")
        u1.wait_for_selector("#done")
        shot(u1, "mock_01_正常時_貸出完了.png")

        # 02 エラー①:画面を開いている間に他の人が先に借りた端末を選んで申請 → E-01
        u2 = new_page(2)
        u2.goto(f"{base}/lendings/new")
        label2 = device_label(u2, "PC-0002")
        u2.select_option("#device_id", label=label2)
        u2.fill("#due_date", due)
        u2.fill("#purpose", "検証")
        u6 = new_page(6)          # その間に渡辺さんが PC-0002 を借りる
        apply_form(u6, "PC-0002", due, "研修")
        u6.click("#submit")
        u6.wait_for_selector("#commit")
        confirm_url = u6.url       # 後で「戻るボタンからの再確定」に使う
        u6.click("#commit")
        u6.wait_for_selector("#done")
        u2.click("#submit")
        u2.wait_for_selector("#banner")
        shot(u2, "mock_02_エラー_貸出中.png")

        # 03 エラー②:返却予定日を過去日にする → E-18
        u2.goto(f"{base}/lendings/new")
        u2.select_option("#device_id", index=1)
        u2.fill("#due_date", fmt(date.today() - timedelta(days=3)))
        u2.fill("#purpose", "検証")
        u2.click("#submit")
        u2.wait_for_selector("#err-due_date")
        shot(u2, "mock_03_エラー_過去日.png")

        # 04 エラー③:同時実行 — 同じ端末の確認画面を 2 人が開き、先に確定された → E-02
        u2.goto(f"{base}/lendings/new")
        u2.select_option("#device_id", label=device_label(u2, "PC-0009"))
        u2.fill("#due_date", due)
        u2.fill("#purpose", "検証")
        u2.click("#submit")                      # 佐藤さん:確認画面まで進む(まだ確定しない)
        u7 = new_page(7)
        apply_form(u7, "PC-0009", due, "常駐先作業")
        u7.click("#submit")
        u7.click("#commit")                      # 中村さんが先に確定
        u7.wait_for_selector("#done")
        u2.click("#commit")                      # 佐藤さんが後から確定
        u2.wait_for_selector("#flash")
        shot(u2, "mock_04_エラー_同時貸出の競合.png")

        # 05 貸出可能端末 0 件 → E-07(DB を直接更新して全ノートPCを修理中にし、撮影後に戻す)
        con = sqlite3.connect(main_db)
        ids = [r[0] for r in con.execute("SELECT id FROM devices WHERE device_type='LAPTOP' AND status='AVAILABLE'")]
        con.execute("UPDATE devices SET status='REPAIR' WHERE id IN (%s)" % ",".join(map(str, ids)))
        con.commit()
        u2.goto(f"{base}/lendings/new")
        shot(u2, "mock_05_貸出可能端末0件.png")
        con.execute("UPDATE devices SET status='AVAILABLE' WHERE id IN (%s)" % ",".join(map(str, ids)))
        con.commit()
        con.close()

        # 06 二重送信の防止 — 「確定」を連打しても 1 件しか登録されない
        u2.goto(f"{base}/lendings/new")
        u2.select_option("#device_id", index=1)
        u2.fill("#due_date", due)
        u2.fill("#purpose", "研修")
        u2.click("#submit")
        u2.locator("#commit").click(click_count=3, delay=20)
        u2.wait_for_selector("#done")
        u2.goto(f"{base}/returns")
        shot(u2, "mock_06_二重送信の防止_1件のみ.png")

        # 07 退職者の貸出がブロックされている → E-08
        u3 = new_page(3)
        u3.goto(f"{base}/lendings/new")
        shot(u3, "mock_07_退職者の貸出.png")

        # 08 延滞中の社員は新規貸出できない → E-12
        u4 = new_page(4)
        u4.goto(f"{base}/lendings/new")
        shot(u4, "mock_08_延滞中は貸出不可.png")

        # 09 返却済みをもう一度返却(別タブ)→ E-26
        u5a = new_page(5)
        u5b = u5a.context.new_page()
        u5a.goto(f"{base}/returns")
        u5b.goto(f"{base}/returns")
        u5a.click("#return")
        u5a.wait_for_selector("#done")
        u5b.click("#return")
        u5b.wait_for_selector("#flash")
        shot(u5b, "mock_09_エラー_二重返却.png")

        # 10 延滞していた端末の返却 → S-03
        u4.goto(f"{base}/returns")
        shot(u4, "mock_10a_延滞バッジ.png")
        u4.click("#return")
        u4.wait_for_selector("#done")
        shot(u4, "mock_10b_延滞後の返却完了.png")

        # 11 確認画面に戻って再確定 → E-14(重複登録なし)
        u6.goto(confirm_url)
        u6.click("#commit")
        u6.wait_for_selector("#notice")
        shot(u6, "mock_11_戻るボタンからの再確定.png")

        # 12 貸出途中でシステムエラー → 全ロールバック(E-30)
        f1 = new_page(1, PORT_FAIL)
        f1.goto(f"http://localhost:{PORT_FAIL}/lendings/new")
        f1.select_option("#device_id", index=1)
        f1.fill("#due_date", due)
        f1.fill("#purpose", "出張")
        f1.click("#submit")
        f1.click("#commit")
        f1.wait_for_selector("#error")
        shot(f1, "mock_12_エラー_システムエラーでロールバック.png")
        f1.goto(f"http://localhost:{PORT_FAIL}/returns")
        shot(f1, "mock_12b_ロールバック後_貸出は残らない.png")

        browser.close()

    for proc in (main_proc, fail_proc):
        proc.terminate()
    print(f"{len(saved)} 枚を {OUT} に保存しました")


if __name__ == "__main__":
    sys.exit(main())
