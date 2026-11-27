// 任用送件檢核伺服器：收到網頁傳來的檔案，交給 Claude 依 rules.md 的標準檢核，回傳結果。
// 金鑰只存在 Cloudflare（ANTHROPIC_API_KEY），不會出現在網頁上。送件檔案不會被儲存；
// 會儲存的只有：帳號（密碼已雜湊）、登入憑證、行事曆整理出的放假日、使用紀錄（誰、何時、檔名、結果，不含檔案內容）。
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, HOLIDAYS } from "./rules.js";
import { reportDateTable } from "./calendar.js";
import { CALENDAR_PROMPT, CALENDAR_SCHEMA, cleanCalendar } from "./holidays.js";
import { login, currentUser, dropSessions, newPasswordRecord, checkPassword, validUsername, publicUser, ROLES, BUILTIN_ADMIN } from "./auth.js";

const MODEL = "claude-opus-5-5";
const MAX_FILES = 40;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
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

// 資料庫（Cloudflare Durable Object，內建 SQLite 儲存）。所有資料都放這裡。
export class Store extends DurableObject {
  async get(key) { return await this.ctx.storage.get(key); }
  async put(key, value) { await this.ctx.storage.put(key, value); }
  async del(key) { await this.ctx.storage.delete(key); }
  async list(options) { return Object.fromEntries(await this.ctx.storage.list(options)); }
}

const dbOf = (env) => env.DB.get(env.DB.idFromName("main"));

async function loadCalendars(db) {
  const years = Object.values(await db.list({ prefix: "cal:" })).sort((a, b) => a.year - b.year);
  return {
    years,
    holidays: new Set([...HOLIDAYS, ...years.flatMap((y) => y.holidays.map((h) => h.date))]),
    workdays: new Set(years.flatMap((y) => y.workdays.map((h) => h.date))),
    coveredYears: new Set(years.map((y) => y.year)),
  };
}

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// 呼叫 Claude，回傳照 schema 的 JSON
async function askClaude(env, { system, content, schema, maxTokens = 32000 }) {
  if (!env.ANTHROPIC_API_KEY) throw new UserError("伺服器尚未設定 ANTHROPIC_API_KEY", 500);
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

function errorResponse(e) {
  if (e instanceof UserError) return fail(e.message, e.status);
  if (e instanceof Anthropic.AuthenticationError) return fail("API 金鑰無效，請檢查 Cloudflare 設定", 500);
  if (e instanceof Anthropic.RateLimitError) return fail("使用量超過上限，請稍後再試", 429);
  if (e instanceof Anthropic.BadRequestError) return fail("檔案無法處理（可能太大或格式不支援）：" + e.message, 400);
  if (e instanceof Anthropic.APIError) return fail(`AI 服務錯誤（${e.status}），請稍後再試`, 502);
  if (e instanceof SyntaxError) return fail("AI 回傳格式異常，請再試一次", 502);
  return fail("處理失敗：" + (e.message || e), 500);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new UserError("資料格式錯誤");
  }
}

function readFiles(body) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) throw new UserError("沒有收到檔案");
  if (files.length > MAX_FILES) throw new UserError(`一次最多 ${MAX_FILES} 個檔案`);
  try {
    return { files, content: toContent(files) };
  } catch (e) {
    throw new UserError(e.message);
  }
}

const taipeiToday = () => new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });

async function addLog(db, entry) {
  const key = "log:" + String(Date.now()).padStart(15, "0") + Math.random().toString(36).slice(2, 6);
  await db.put(key, { time: new Date().toISOString(), ...entry });
}

// ===== 檢核送件 =====
async function handleCheck(request, env, db, user) {
  const body = await readBody(request);
  const { files, content } = readFiles(body);
  const note = typeof body.note === "string" && body.note.trim()
    ? `\n承辦人補充說明：${body.note.trim().slice(0, 2000)}`
    : "";
  const unit = ["分公司", "總公司"].includes(body.unit)
    ? `\n送件單位（承辦人指定）：${body.unit}`
    : "\n送件單位：未指定，請依任用單位欄位自動判斷。";
  const cal = await loadCalendars(db);
  content.push({
    type: "text",
    text: `今天日期：${taipeiToday()}。以上是這次的送件，共 ${files.length} 個檔案。請依檢核標準逐條檢核。${unit}${note}\n\n可報到日期表（每週第一個工作日、每月第一個工作日，已排除週末與國定假日；任用意見表的報到日期不在表上即不通過）：\n${reportDateTable(cal)}`,
  });
  const fileNames = files.map((f) => String(f.name || "").slice(0, 100));
  try {
    const result = await askClaude(env, { system: SYSTEM_PROMPT, content, schema: OUTPUT_SCHEMA });
    const count = (s) => result.items.filter((i) => i.status === s).length;
    await addLog(db, {
      username: user.username, name: user.name, action: "檢核", files: fileNames,
      applicant: result.applicant_name, overall: result.overall,
      fail: count("fail"), warn: count("warn"), tokens: result.usage,
    });
    return json(result);
  } catch (e) {
    await addLog(db, { username: user.username, name: user.name, action: "檢核", files: fileNames, overall: "error", error: String(e.message || e).slice(0, 200) });
    throw e;
  }
}

// ===== 行事曆（管理者上傳） =====
async function handleCalendarUpload(request, env, db, user) {
  const { files, content } = readFiles(await readBody(request));
  content.push({ type: "text", text: "請讀出以上行事曆中所有的放假日與補行上班日。" });
  const raw = await askClaude(env, { system: CALENDAR_PROMPT, content, schema: CALENDAR_SCHEMA });
  const source = files.map((f) => String(f.name || "")).join("、").slice(0, 300);
  const saved = [];
  for (const y of cleanCalendar(raw)) {
    const data = { ...y, source, updated: new Date().toISOString(), by: user.name };
    await db.put("cal:" + y.year, data);
    saved.push(data);
  }
  if (!saved.length) throw new UserError("沒有從檔案中讀到任何放假日，請確認上傳的是人事行政總處行事曆。");
  await addLog(db, { username: user.username, name: user.name, action: "上傳行事曆", files: files.map((f) => String(f.name || "")), overall: saved.map((y) => y.year).join("、") });
  return json({ saved, notes: raw.notes || "" });
}

// ===== 帳號管理（管理者） =====
async function listUsers(db) {
  const users = Object.values(await db.list({ prefix: "user:" })).map(publicUser);
  return users.sort((a, b) => a.username.localeCompare(b.username));
}

async function handleSaveUser(request, db, admin) {
  const b = await readBody(request);
  const username = String(b.username || "").trim().toLowerCase();
  if (!validUsername(username)) throw new UserError("帳號只能用英文、數字、._-，長度 2～32 字");
  if (username === BUILTIN_ADMIN) throw new UserError("admin 是內建帳號，不能修改");
  if (!ROLES[b.role]) throw new UserError("請選擇權限");
  const name = String(b.name || "").trim().slice(0, 30);
  if (!name) throw new UserError("請填姓名");

  const key = "user:" + username;
  const old = await db.get(key);
  if (b.create && old) throw new UserError("這個帳號已經存在");
  if (!b.create && !old) throw new UserError("找不到這個帳號");

  let rec = old || { username, created: new Date().toISOString() };
  rec = { ...rec, name, role: b.role, active: b.active !== false };
  if (b.password || b.create) {
    const err = checkPassword(b.password);
    if (err) throw new UserError(err);
    rec = { ...rec, ...(await newPasswordRecord(b.password)) };
  }
  await db.put(key, rec);
  if (old && (b.password || rec.active === false || old.role !== rec.role)) await dropSessions(db, username);
  await addLog(db, { username: admin.username, name: admin.name, action: b.create ? "新增帳號" : "修改帳號", overall: `${username}（${ROLES[rec.role]}${rec.active ? "" : "，停用"}${b.password && !b.create ? "，重設密碼" : ""}）` });
  return json({ user: publicUser(rec) });
}

async function handleDeleteUser(request, db, admin) {
  const { username } = await readBody(request);
  if (!(await db.get("user:" + username))) throw new UserError("找不到這個帳號");
  await db.del("user:" + username);
  await dropSessions(db, username);
  await addLog(db, { username: admin.username, name: admin.name, action: "刪除帳號", overall: username });
  return json({ ok: true });
}

// 使用者自己改密碼
async function handleChangePassword(request, db, user) {
  if (user.username === BUILTIN_ADMIN) throw new UserError("admin 的密碼請到 Cloudflare 的 ADMIN_PASSWORD 修改");
  const { oldPassword, newPassword } = await readBody(request);
  try {
    await login(db, {}, user.username, oldPassword);
  } catch {
    throw new UserError("目前的密碼不正確");
  }
  const err = checkPassword(newPassword);
  if (err) throw new UserError(err);
  const rec = await db.get("user:" + user.username);
  await db.put("user:" + user.username, { ...rec, ...(await newPasswordRecord(newPassword)) });
  await dropSessions(db, user.username);
  return json({ ok: true });
}

// ===== 路由 =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/") {
      return new Response("任用送件檢核伺服器運作中 ✅", {
        headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    const db = dbOf(env);
    const GET = request.method === "GET", POST = request.method === "POST";
    try {
      if (path === "/login" && POST) {
        const { username, password } = await readBody(request);
        try {
          return json(await login(db, env, username, password));
        } catch (e) {
          return fail(e.message, 401);
        }
      }

      const user = await currentUser(db, request);
      if (!user) return fail("請先登入", 401);

      if (path === "/me" && GET) return json({ user: { ...user, token: undefined } });
      if (path === "/logout" && POST) {
        await db.del("session:" + user.token);
        return json({ ok: true });
      }
      if (path === "/password" && POST) return await handleChangePassword(request, db, user);
      if (path === "/check" && POST) return await handleCheck(request, env, db, user);
      if (path === "/calendar" && GET) return json({ years: (await loadCalendars(db)).years });

      // 以下只有管理者可以用
      if (user.role !== "admin") return fail("只有管理者可以使用這個功能", 403);
      if (path === "/calendar" && POST) return await handleCalendarUpload(request, env, db, user);
      if (path === "/admin/users" && GET) return json({ users: await listUsers(db) });
      if (path === "/admin/users" && POST) return await handleSaveUser(request, db, user);
      if (path === "/admin/users/delete" && POST) return await handleDeleteUser(request, db, user);
      if (path === "/admin/logs" && GET) {
        const limit = Math.min(500, Number(url.searchParams.get("limit")) || 200);
        return json({ logs: Object.values(await db.list({ prefix: "log:", reverse: true, limit })) });
      }
      return fail("找不到這個功能", 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
