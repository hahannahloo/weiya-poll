# 入職小幫手 HR Helper｜任用資料審核

上傳新進人員的任用送件（PDF、Word、Excel、照片），AI 依分公司／總公司的送件規範逐條檢核，列出不通過與需確認的項目和修正方式。流程分為「傳 → 審 → 修 → 印 → 送」五個步驟。

- 網頁：`doc-check/index.html`（同仁用註冊碼自行註冊；使用者看自己的紀錄，管理者看全部）
- 伺服器：`doc-check/worker/`（Cloudflare Worker）
- 檢核規則：在網頁「管理」頁維護，分公司、總公司各一套；預設值在 `doc-check/worker/rules/`
- 設定與使用方式：[doc-check/使用說明.md](doc-check/使用說明.md)
