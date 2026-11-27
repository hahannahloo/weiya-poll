# 尾牙即時投票

來賓掃 QR Code 用手機投票，大螢幕即時顯示統計結果。

- 大螢幕：`/#screen`
- 手機投票：`/#vote`
- 主持人控制台：`/#admin`

即時伺服器在 `worker/`（Cloudflare）。設定方式請看 [使用說明.md](使用說明.md)。

---

# 任用送件檢核（`doc-check/`）

上傳任用送件（PDF、照片、Word、Excel），AI 依「分公司業務任用送件範例」逐條檢核，產出不通過說明。

- 網頁：`/doc-check/`（同仁用註冊碼自行註冊；使用者看自己的紀錄，管理者看全部）
- 檢核標準：在網頁「管理」頁維護（分公司、總公司各一套；預設值在 `doc-check/worker/rules/`）
- 設定方式請看 [doc-check/使用說明.md](doc-check/使用說明.md)
