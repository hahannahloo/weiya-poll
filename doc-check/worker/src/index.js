// 任用送件檢核伺服器：收到網頁傳來的檔案，交給 Claude 依 rules.md 的標準檢核，回傳結果。
// 金鑰只存在 Cloudflare（ANTHROPIC_API_KEY），不會出現在網頁上。送件檔案不會被儲存；
// 只有上傳的行事曆會被整理成「放假日清單」存起來，用來計算可報到日期。
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, HOLIDAYS } from "./rules.js";
import { reportDateTable } from "./calendar.js";
import { CALENDAR_PROMPT, CALENDAR_SCHEMA, cleanCalendar } from "./holidays.js";

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

// 放假日清單的儲存空間（每年一筆）
export class CalendarStore extends DurableObject {
  async getAll() {
    return Object.fromEntries(await this.ctx.storage.list({ prefix: "cal:" }));
  }
  async putYear(year, data) {
    await this.ctx.storage.put("cal:" + year, data);
  }
}

const store = (env) => env.CAL.get(env.CAL.idFromName("main"));

async function loadCalendars(env) {
  const all = await store(env).getAll();
  const years = Object.values(all).sort((a, b) => a.year - b.year);
  return {
    years,
    holidays: new Set([...HOLIDAYS, ...years.flatMap((y) => y.holidays.map((h) => h.date))]),
    workdays: new Set(years.flatMap((y) => y.workdays.map((h) => h.date))),
    coveredYears: new Set(years.map((y) => y.year)),
  };
}

// 呼叫 Claude，回傳照 schema 的 JSON
async function askClaude(env, { system, content, schema, maxTokens = 32000 }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema } },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new UserError("AI 拒絕處理這份文件，請確認上傳內容是否正確。", 502);
  if (message.stop_reason === "max_tokens") throw new UserError("內容太多，結果超過長度上限，請分批上傳。", 502);
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const result = JSON.parse(text);
  result.usage = { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
  return result;
}

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function errorResponse(e) {
  if (e instanceof UserError) return fail(e.message, e.status);
  if (e instanceof Anthropic.AuthenticationError) return fail("API 金鑰無效，請檢查 Cloudflare 設定", 500);
  if (e instanceof Anthropic.RateLimitError) return fail("使用量超過上限，請稍後再試", 429);
  if (e instanceof Anthropic.BadRequestError) return fail("檔案無法處理（可能太大或格式不支援）：" + e.message, 400);
  if (e instanceof Anthropic.APIError) return fail(`AI 服務錯誤（${e.status}），請稍後再試`, 502);
  if (e instanceof SyntaxError) return fail("AI 回傳格式異常，請再試一次", 502);
  return fail("處理失敗：" + (e.message || e), 500);
}

async function readFiles(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new UserError("資料格式錯誤");
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) throw new UserError("沒有收到檔案");
  if (files.length > MAX_FILES) throw new UserError(`一次最多 ${MAX_FILES} 個檔案`);
  try {
    return { body, files, content: toContent(files) };
  } catch (e) {
    throw new UserError(e.message);
  }
}

const taipeiToday = () => new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });

// 檢核送件
async function handleCheck(request, env) {
  const { body, files, content } = await readFiles(request);
  const note = typeof body.note === "string" && body.note.trim()
    ? `\n承辦人補充說明：${body.note.trim().slice(0, 2000)}`
    : "";
  const unit = ["分公司", "總公司"].includes(body.unit)
    ? `\n送件單位（承辦人指定）：${body.unit}`
    : "\n送件單位：未指定，請依任用單位欄位自動判斷。";
  const cal = await loadCalendars(env);
  content.push({
    type: "text",
    text: `今天日期：${taipeiToday()}。以上是這次的送件，共 ${files.length} 個檔案。請依檢核標準逐條檢核。${unit}${note}\n\n可報到日期表（每週第一個工作日、每月第一個工作日，已排除週末與國定假日；任用意見表的報到日期不在表上即不通過）：\n${reportDateTable(cal)}`,
  });
  return json(await askClaude(env, { system: SYSTEM_PROMPT, content, schema: OUTPUT_SCHEMA }));
}

// 上傳行事曆：讀出放假日與補行上班日，依年份存起來
async function handleCalendarUpload(request, env) {
  const { files, content } = await readFiles(request);
  content.push({ type: "text", text: "請讀出以上行事曆中所有的放假日與補行上班日。" });
  const raw = await askClaude(env, { system: CALENDAR_PROMPT, content, schema: CALENDAR_SCHEMA });
  const source = files.map((f) => String(f.name || "")).join("、").slice(0, 300);
  const saved = [];
  for (const y of cleanCalendar(raw)) {
    const data = { ...y, source, updated: new Date().toISOString() };
    await store(env).putYear(y.year, data);
    saved.push(data);
  }
  if (!saved.length) throw new UserError("沒有從檔案中讀到任何放假日，請確認上傳的是人事行政總處行事曆。");
  return json({ saved, notes: raw.notes || "" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (url.pathname === "/calendar" && request.method === "GET") {
        const { years } = await loadCalendars(env);
        return json({ years });
      }
      if (url.pathname === "/check" || url.pathname === "/calendar") {
        if (request.method !== "POST") return fail("請用 POST", 405);
        if (!env.ANTHROPIC_API_KEY) return fail("伺服器尚未設定 ANTHROPIC_API_KEY", 500);
        if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
          return fail("存取密碼錯誤", 401);
        }
        return url.pathname === "/check" ? await handleCheck(request, env) : await handleCalendarUpload(request, env);
      }
    } catch (e) {
      return errorResponse(e);
    }

    return new Response("任用送件檢核伺服器運作中 ✅", {
      headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
    });
  },
};
