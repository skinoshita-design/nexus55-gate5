"""NEXUS に提出するファイルを submit/ に作る: python tools/make_submission.py

- 例外系洗い出し表.csv … docs/01_例外系洗い出し表.md の洗い出しシートを 1 枚の CSV にする
- モック画像_エラー時.zip … mock/ の画像をまとめる
- 補完後フロー図.png      … docs/04_補完後フロー図.png のコピー
"""
import csv
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "submit"
OUT.mkdir(exist_ok=True)

CATEGORIES = {
    "①": "① 在庫・状態", "②": "② 人の状態", "③": "③ 重複・多重", "④": "④ 入力値",
    "⑤": "⑤ 順序", "⑥": "⑥ 時間", "⑦": "⑦ 失敗時", "⑧": "⑧ 不正操作",
}


def clean(text):
    """Markdown の装飾を外す"""
    return re.sub(r"`|\*\*", "", text).strip()


def build_csv():
    md = (ROOT / "docs" / "01_例外系洗い出し表.md").read_text(encoding="utf-8")
    rows = []
    for line in md.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        # 洗い出しシートの行:No | 観点 | 状況 | 問題 | 仕様 | 検知タイミング | 画面表示 | 優先度
        if len(cells) == 8 and cells[0].isdigit() and cells[1] in CATEGORIES:
            no, cat, situation, problem, spec, timing, display, priority = map(clean, cells)
            # 資料:「いつ検知して」「画面に何と出すか」まで書いて初めて仕様 → 検知タイミングを決めた仕様に含める
            rows.append([no, CATEGORIES[cat], situation, problem, f"{spec}(検知:{timing})", display, priority])
    assert len(rows) == 39, f"洗い出し項目数が想定と違います: {len(rows)}"
    path = OUT / "例外系洗い出し表.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as f:  # BOM 付き(Excel で文字化けしない)
        w = csv.writer(f)
        w.writerow(["No", "観点", "状況", "起きる問題", "決めた仕様", "画面表示", "優先度"])
        w.writerows(rows)
    return path, len(rows)


def build_zip():
    path = OUT / "モック画像_エラー時.zip"
    images = sorted((ROOT / "mock").glob("*.png"))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for img in images:
            z.write(img, img.name)
    return path, len(images)


def main():
    csv_path, n = build_csv()
    zip_path, m = build_zip()
    flow = OUT / "補完後フロー図.png"
    shutil.copyfile(ROOT / "docs" / "04_補完後フロー図.png", flow)
    print(f"{csv_path.name}: {n} 件")
    print(f"{zip_path.name}: {m} 枚")
    print(f"{flow.name}: コピー")


if __name__ == "__main__":
    main()
