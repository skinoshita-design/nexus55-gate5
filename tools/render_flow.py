"""docs/02_例外系仕様書.md の補完後フロー図(Mermaid)を PNG に書き出す: python tools/render_flow.py
mermaid は cdn.jsdelivr.net から読み込む(バージョン固定)。ブラウザは PC の Chrome を使う。
"""
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
doc = (ROOT / "docs" / "02_例外系仕様書.md").read_text(encoding="utf-8")
blocks = re.findall(r"```mermaid\n(.*?)```", doc, re.S)
flow = next(b for b in blocks if b.lstrip().startswith("flowchart"))

html = f"""<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#fff">
<pre class="mermaid">{flow}</pre>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs";
mermaid.initialize({{ startOnLoad: false, flowchart: {{ useMaxWidth: false, htmlLabels: true }}, theme: "default" }});
await mermaid.run();
document.body.dataset.done = "1";
</script>"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1800, "height": 1200}, device_scale_factor=1.5)
    page.set_content(html)
    page.wait_for_selector("body[data-done='1'] svg", timeout=60000)
    out = ROOT / "docs" / "04_補完後フロー図.png"
    page.locator("svg").first.screenshot(path=str(out))
    browser.close()
print("saved", out.name)
