// 任用送件檢核伺服器：收到網頁傳來的檔案，交給 Claude 依 rules.js 的標準檢核，回傳結果。
// 金鑰只存在 Cloudflare（ANTHROPIC_API_KEY），不會出現在網頁上。檔案不會被儲存。
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from "./rules.js";

const MODEL = "claude-opus-5-5";
const MAX_FILES = 40;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-access-code",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

// 把網頁傳來的檔案轉成 Claude 看得懂的內容
function toContent(files) {
  const content = [];
  files.forEach((f, i) => {
    const label = `【檔案 ${i + 1}：${String(f.name || "未命名").slice(0, 200)}】`;
    if (f.kind === "pdf") {
      content.push({ type: "text", text: label + "（PDF）" });
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: f.data },
      });
    } else if (f.kind === "image") {
      if (!IMAGE_TYPES.includes(f.media_type)) throw new Error(`不支援的圖片格式：${f.name}`);
      content.push({ type: "text", text: label + "（圖片）" });
      content.push({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } });
    } else if (f.kind === "text") {
      content.push({ type: "text", text: `${label}（由 Word/Excel/文字檔轉出的內容）\n${f.data}` });
    } else {
      throw new Error(`不支援的檔案：${f.name}`);
    }
  });
  return content;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname !== "/check") {
      return new Response("任用送件檢核伺服器運作中 ✅", {
        headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.method !== "POST") return fail("請用 POST", 405);

    if (!env.ANTHROPIC_API_KEY) return fail("伺服器尚未設定 ANTHROPIC_API_KEY", 500);
    if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
      return fail("存取密碼錯誤", 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("資料格式錯誤");
    }
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) return fail("沒有收到檔案");
    if (files.length > MAX_FILES) return fail(`一次最多 ${MAX_FILES} 個檔案`);

    let content;
    try {
      content = toContent(files);
    } catch (e) {
      return fail(e.message);
    }

    const today = new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
    const note = typeof body.note === "string" && body.note.trim()
      ? `\n承辦人補充說明：${body.note.trim().slice(0, 2000)}`
      : "";
    const unit = ["分公司", "總公司"].includes(body.unit)
      ? `\n送件單位（承辦人指定）：${body.unit}`
      : "\n送件單位：未指定，請依任用單位欄位自動判斷。";
    content.push({
      type: "text",
      text: `今天日期：${today}。以上是這次的送件，共 ${files.length} 個檔案。請依檢核標準逐條檢核。${unit}${note}`,
    });

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
      });
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        return fail("AI 拒絕處理這份文件，請確認上傳內容是否正確。", 502);
      }
      if (message.stop_reason === "max_tokens") {
        return fail("文件太多，檢核結果超過長度上限，請分批上傳。", 502);
      }
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const result = JSON.parse(text);
      result.usage = {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      };
      return json(result);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return fail("API 金鑰無效，請檢查 Cloudflare 設定", 500);
      if (e instanceof Anthropic.RateLimitError) return fail("使用量超過上限，請稍後再試", 429);
      if (e instanceof Anthropic.BadRequestError) return fail("檔案無法處理（可能太大或格式不支援）：" + e.message, 400);
      if (e instanceof Anthropic.APIError) return fail(`AI 服務錯誤（${e.status}），請稍後再試`, 502);
      if (e instanceof SyntaxError) return fail("AI 回傳格式異常，請再試一次", 502);
      return fail("檢核失敗：" + (e.message || e), 500);
    }
  },
};
