// 任用送件檢核伺服器：收到網頁傳來的檔案，交給 Claude 依 rules.md 的標準檢核，回傳結果。
// 金鑰只存在 Cloudflare（ANTHROPIC_API_KEY），不會出現在網頁上。送件檔案不會被儲存；
// 會儲存：帳號（密碼已雜湊）、登入憑證、行事曆整理出的放假日、檢核紀錄（上傳的檔案與結果，作為歷史軌跡）、使用紀錄。
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { systemPrompt, OUTPUT_SCHEMA, RULE_DRAFT_PROMPT, RULE_DRAFT_SCHEMA } from "./rules.js";
import { UNITS, currentRules, saveRules, ruleHistory, ruleVersion } from "./rulesets.js";
import { reportDateTable } from "./calendar.js";
import { CALENDAR_PROMPT, CALENDAR_SCHEMA, cleanCalendar } from "./holidays.js";
import { saveRecord, listRecords, getRecord, getFile, deleteRecord, addLog, checkRetention, runCleanup } from "./records.js";
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
  // 清理過期資料直接在資料庫裡執行，不用來回傳資料
  async cleanup() {
    const storage = this.ctx.storage;
    const db = {
      get: (k) => storage.get(k), put: (k, v) => storage.put(k, v), del: (k) => storage.delete(k),
      list: async (o) => Object.fromEntries(await storage.list(o)),
    };
    return await runCleanup(db);
  }
}

const dbOf = (env) => env.DB.get(env.DB.idFromName("main"));

async function loadCalendars(db) {
  const years = Object.values(await db.list({ prefix: "cal:" })).sort((a, b) => a.year - b.year);
  return {
    years,
    holidays: new Set(years.flatMap((y) => y.holidays.map((h) => h.date))),
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

// 把錯誤轉成看得懂的中文訊息
function explain(e) {
  if (e instanceof UserError) return [e.message, e.status];
  if (e instanceof Anthropic.AuthenticationError) return ["API 金鑰無效，請檢查 Cloudflare 設定", 500];
  if (e instanceof Anthropic.RateLimitError) return ["使用量超過上限，請稍後再試", 429];
  if (e instanceof Anthropic.BadRequestError) return ["檔案無法處理（可能太大或格式不支援）：" + e.message, 400];
  if (e instanceof Anthropic.APIError) return [`AI 服務錯誤（${e.status}），請稍後再試`, 502];
  if (e instanceof SyntaxError) return ["AI 回傳格式異常，請再試一次", 502];
  return ["處理失敗：" + (e.message || e), 500];
}

function errorResponse(e) {
  const [msg, status] = explain(e);
  return fail(msg, status);
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


// ===== 檢核送件 =====
async function handleCheck(request, env, db, user) {
  const body = await readBody(request);
  const { files, content } = readFiles(body);
  const note = typeof body.note === "string" && body.note.trim()
    ? `\n承辦人補充說明：${body.note.trim().slice(0, 2000)}`
    : "";
  if (!UNITS.includes(body.unit)) throw new UserError("請選擇送件單位（分公司或總公司）");
  const ruleset = await currentRules(db, body.unit);
  const unit = `\n送件單位：${body.unit}（使用${body.unit}規則第 ${ruleset.version} 版）`;
  const cal = await loadCalendars(db);
  content.push({
    type: "text",
    text: `今天日期：${taipeiToday()}。以上是這次的送件，共 ${files.length} 個檔案。請依檢核標準逐條檢核。${unit}${note}\n\n可報到日期表（每週第一個工作日、每月第一個工作日，已排除週末與國定假日；任用意見表的報到日期不在表上即不通過）：\n${reportDateTable(cal)}`,
  });
  const fileNames = files.map((f) => String(f.name || "").slice(0, 100));
  const keep = { user, files, note: String(body.note || "").slice(0, 2000), unit: body.unit, ruleVersion: ruleset.version };
  try {
    const result = await askClaude(env, { system: systemPrompt(body.unit, ruleset.text), content, schema: OUTPUT_SCHEMA });
    const count = (s) => result.items.filter((i) => i.status === s).length;
    const id = await saveRecord(db, { ...keep, result });
    await addLog(db, {
      username: user.username, name: user.name, action: "檢核", files: fileNames, record: id,
      applicant: result.applicant_name, overall: result.overall,
      fail: count("fail"), warn: count("warn"), tokens: result.usage,
    });
    return json({ ...result, record_id: id });
  } catch (e) {
    const msg = explain(e)[0].slice(0, 200);
    const id = await saveRecord(db, { ...keep, error: msg }).catch(() => null);
    await addLog(db, { username: user.username, name: user.name, action: "檢核", files: fileNames, record: id, overall: "error", error: msg });
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

// ===== 自行註冊（需要管理者設定的註冊碼） =====
async function handleRegister(request, env, db) {
  const b = await readBody(request);
  const code = await db.get("setting:signupCode");
  if (!code) throw new UserError("目前尚未開放註冊，請洽管理者", 403);
  if (String(b.code || "").trim() !== code) throw new UserError("註冊碼不正確，請向管理者確認", 403);
  const username = String(b.username || "").trim().toLowerCase();
  if (!validUsername(username) || username === BUILTIN_ADMIN) throw new UserError("帳號只能用英文、數字、._-，長度 2～32 字");
  const name = String(b.name || "").trim().slice(0, 30);
  if (!name) throw new UserError("請填姓名");
  const err = checkPassword(b.password);
  if (err) throw new UserError(err);
  if (await db.get("user:" + username)) throw new UserError("這個帳號已經有人使用，請換一個");
  await db.put("user:" + username, {
    username, name, role: "user", active: true, created: new Date().toISOString(), selfRegistered: true,
    ...(await newPasswordRecord(b.password)),
  });
  await addLog(db, { username, name, action: "註冊帳號", overall: username });
  return json(await login(db, env, username, b.password));
}

// ===== 路由 =====
export default {
  // 每天凌晨（台灣時間 2:00）自動依保存期限清理
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dbOf(env).cleanup());
  },

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

      if (path === "/register" && POST) return await handleRegister(request, env, db);

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

      // 檢核紀錄：一般使用者只看得到自己的，管理者看得到全部（可用 ?user= 篩選）
      if (path === "/records" && GET) {
        const who = user.role === "admin" ? (url.searchParams.get("user") || "").toLowerCase() : user.username;
        return json(await listRecords(db, { username: who, before: url.searchParams.get("before") }));
      }
      const recMatch = path.match(/^\/records\/([0-9a-z]+)(?:\/files\/(\d+))?$/);
      if (recMatch && GET) {
        const rec = await getRecord(db, recMatch[1], user);
        if (!rec) return fail("找不到這筆紀錄", 404);
        if (recMatch[2] === undefined) return json({ record: rec });
        const file = await getFile(db, rec, Number(recMatch[2]));
        return file ? json({ file }) : fail("找不到這個檔案", 404);
      }

      // 以下只有管理者可以用
      if (user.role !== "admin") return fail("只有管理者可以使用這個功能", 403);
      if (path === "/calendar" && POST) return await handleCalendarUpload(request, env, db, user);
      if (path === "/admin/users" && GET) return json({ users: await listUsers(db) });
      if (path === "/admin/users" && POST) return await handleSaveUser(request, db, user);
      if (path === "/admin/users/delete" && POST) return await handleDeleteUser(request, db, user);
      if (path === "/admin/records/delete" && POST) {
        const { id } = await readBody(request);
        const rec = await getRecord(db, id, user);
        if (!rec) return fail("找不到這筆紀錄", 404);
        await deleteRecord(db, rec);
        await addLog(db, { username: user.username, name: user.name, action: "刪除檢核紀錄", overall: `${rec.name} ${rec.time.slice(0, 10)} ${rec.result?.applicant_name || ""}`, files: rec.files.map((f) => f.name) });
        return json({ ok: true });
      }
      // 檢核規則（分公司／總公司），每次儲存成新版本
      if (path === "/admin/rules" && GET) {
        const unit = url.searchParams.get("unit");
        const v = url.searchParams.get("version");
        if (v !== null) {
          const r = await ruleVersion(db, unit, v);
          return r ? json({ rules: r }) : fail("找不到這個版本", 404);
        }
        return json({ rules: await currentRules(db, unit), history: await ruleHistory(db, unit) });
      }
      if (path === "/admin/rules" && POST) {
        const b = await readBody(request);
        let saved;
        try {
          saved = await saveRules(db, b.unit, b.text, b.note, user);
        } catch (e) {
          throw new UserError(e.message);
        }
        await addLog(db, { username: user.username, name: user.name, action: "修改檢核規則", overall: `${saved.unit}規則第 ${saved.version} 版${saved.note ? "：" + saved.note : ""}` });
        return json({ rules: saved });
      }
      if (path === "/admin/rules/draft" && POST) {
        const b = await readBody(request);
        const cur = await currentRules(db, b.unit);
        const { files, content } = readFiles(b);
        content.unshift({ type: "text", text: `以下是「${cur.unit}」目前的檢核規則（第 ${cur.version} 版）：\n\n${cur.text}\n\n接下來是新的送件範例：` });
        const note = String(b.note || "").trim().slice(0, 2000);
        content.push({ type: "text", text: `請依新範例產生更新後的完整規則。${note ? "\n管理者說明：" + note : ""}` });
        const draft = await askClaude(env, { system: RULE_DRAFT_PROMPT, content, schema: RULE_DRAFT_SCHEMA });
        await addLog(db, { username: user.username, name: user.name, action: "依範例產生規則草稿", files: files.map((f) => String(f.name || "")), overall: `${cur.unit}（尚未儲存）` });
        return json({ draft, baseVersion: cur.version });
      }
      if (path === "/admin/settings" && GET) {
        return json({
          signupCode: (await db.get("setting:signupCode")) || "",
          retention: (await db.get("setting:retention")) || { fileDays: 0, resultDays: 0 },
        });
      }
      if (path === "/admin/retention" && POST) {
        const b = await readBody(request);
        let r;
        try {
          r = checkRetention(b.fileDays, b.resultDays);
        } catch (e) {
          throw new UserError(e.message);
        }
        await db.put("setting:retention", r);
        const txt = (d) => (d ? `${d} 天` : "不自動刪除");
        await addLog(db, { username: user.username, name: user.name, action: "設定保存期限", overall: `檔案：${txt(r.fileDays)}；結果：${txt(r.resultDays)}` });
        const counts = await db.cleanup();
        return json({ retention: r, cleaned: counts });
      }
      if (path === "/admin/settings" && POST) {
        const { signupCode } = await readBody(request);
        const code = String(signupCode || "").trim();
        if (code && code.length < 4) throw new UserError("註冊碼至少 4 個字元");
        if (code) await db.put("setting:signupCode", code.slice(0, 50));
        else await db.del("setting:signupCode");
        await addLog(db, { username: user.username, name: user.name, action: code ? "設定註冊碼" : "關閉註冊", overall: "" });
        return json({ signupCode: code });
      }
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
