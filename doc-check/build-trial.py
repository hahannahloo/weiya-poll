"""產生「介面展示版」預覽頁：不需要伺服器，用瀏覽器裡的假伺服器展示登入、紀錄、管理等畫面，檢核可直接用 Claude。

把伺服器端的規則全文、AI 指示、輸出格式、可報到日期計算與防漏檢查一起打包進網頁，
確保試用版和正式版用的是同一套規則與邏輯。

用法：python3 doc-check/build-trial.py 輸出檔.html
"""
import json
import re
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
worker = here / "worker"


def module(path):
    """去掉 ES module 的 export／import，讓程式可以直接放進網頁。"""
    src = (worker / "src" / path).read_text(encoding="utf-8")
    src = re.sub(r"^import .*?;\n", "", src, flags=re.M)
    return re.sub(r"^export ", "", src, flags=re.M)


rulesets = (worker / "src" / "rulesets.js").read_text(encoding="utf-8")
checklist_fn = re.search(r"export function checklistOf[\s\S]*?\n}\n", rulesets).group(0).replace("export ", "")

rules = {
    "分公司": (worker / "rules" / "branch.md").read_text(encoding="utf-8").strip(),
    "總公司": (worker / "rules" / "head-office.md").read_text(encoding="utf-8").strip(),
}

bundle = "\n".join([
    "<script>",
    "// 試用版：由 build-trial.py 從 worker/ 打包，請勿直接修改",
    "const TRIAL = (() => {",
    module("calendar.js"),
    module("coverage.js"),
    module("rules.js"),
    checklist_fn,
    "const RULES = " + json.dumps(rules, ensure_ascii=False).replace("<", "\\u003c") + ";",
    "return { reportDateTable, ensureCoverage, systemPrompt, OUTPUT_SCHEMA, checklistOf, RULES };",
    "})();",
    "</script>",
    "<script>",
    (here / "demo" / "mock-api.js").read_text(encoding="utf-8"),
    "</script>",
])

page = (here / "index.html").read_text(encoding="utf-8")
# 預覽頁會自動包上 <html><head><body>，這裡拿掉自己的外框
for pattern in [r"<!doctype html>\n", r"<html[^>]*>\n", r"</?head>\n", r"</?body>\n", r"</html>\n?",
                r'<meta charset="utf-8">\n', r'<meta name="viewport"[^>]*>\n']:
    page = re.sub(pattern, "", page, flags=re.I)
page = page.replace("<script>\n// ===== 設定 =====", bundle + "\n<script>\n// ===== 設定 =====", 1)
assert "const TRIAL" in page, "找不到插入位置"
Path(sys.argv[1]).write_text(page, encoding="utf-8")
print("built", sys.argv[1], len(page), "bytes")
