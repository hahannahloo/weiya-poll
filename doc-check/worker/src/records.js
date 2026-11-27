// 檢核紀錄：每次檢核都保存上傳的檔案和結果，作為歷史軌跡。
// 一般使用者只看得到自己的紀錄；管理者看得到全部。只有管理者可以刪除，刪除也會記在使用紀錄裡。
//
// 儲存方式（同一個資料庫）：
//   rec:<id>                  完整紀錄（含檢核結果）
//   sum:<id>                  摘要（列表用）
//   usum:<帳號>:<id>          同一份摘要，依帳號分開，方便列出「我的紀錄」
//   file:<id>:<第幾個檔>:<第幾段>  檔案內容（分段存，每段不超過 1MB）

const CHUNK = 1_000_000;
const DAY = 86400000;

export async function addLog(db, entry) {
  const key = "log:" + String(Date.now()).padStart(15, "0") + Math.random().toString(36).slice(2, 6);
  await db.put(key, { time: new Date().toISOString(), ...entry });
}

export const newId = (t = Date.now()) => String(t).padStart(15, "0") + Math.random().toString(36).slice(2, 6);

function summaryOf(rec) {
  const r = rec.result;
  const count = (s) => (r ? r.items.filter((i) => i.status === s).length : 0);
  return {
    id: rec.id, time: rec.time, username: rec.username, name: rec.name,
    applicant: r?.applicant_name || "", overall: r ? r.overall : "error",
    fail: count("fail"), warn: count("warn"), fileCount: rec.files.length,
    error: rec.error || "", override: !!rec.override, submittedAt: rec.submittedAt || null,
  };
}

export async function saveRecord(db, { user, files, note, unit, ruleVersion, result, error }) {
  const now = Date.now();
  const id = newId(now);
  const meta = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const data = String(f.data || "");
    const chunks = Math.max(1, Math.ceil(data.length / CHUNK));
    for (let c = 0; c < chunks; c++) await db.put(`file:${id}:${i}:${c}`, data.slice(c * CHUNK, (c + 1) * CHUNK));
    meta.push({ name: String(f.name || "").slice(0, 200), kind: f.kind, media_type: f.media_type || "", size: data.length, chunks });
  }
  const rec = {
    id, time: new Date(now).toISOString(), username: user.username, name: user.name,
    note: note || "", unit: unit || "", ruleVersion: ruleVersion ?? null, files: meta, result: result || null,
    error: error ? String(error).slice(0, 300) : "",
  };
  await db.put("rec:" + id, rec);
  const sum = summaryOf(rec);
  await db.put("sum:" + id, sum);
  await db.put(`usum:${user.username}:${id}`, sum);
  return id;
}

// 列出紀錄（新到舊），before = 上一頁最後一筆的 id
export async function listRecords(db, { username, before, limit = 50 }) {
  const prefix = username ? `usum:${username}:` : "sum:";
  const opts = { prefix, reverse: true, limit: limit + 1 };
  if (before) opts.end = prefix + before;
  const list = Object.values(await db.list(opts));
  return { records: list.slice(0, limit), more: list.length > limit };
}

// 讀取一筆紀錄；不是本人也不是管理者就當作找不到
export async function getRecord(db, id, user) {
  if (!/^[0-9a-z]{15,25}$/.test(String(id))) return null;
  const rec = await db.get("rec:" + id);
  if (!rec) return null;
  if (user.role !== "admin" && rec.username !== user.username) return null;
  return rec;
}

export async function getFile(db, rec, index) {
  const f = rec.files[index];
  if (!f || rec.filesDeleted) return null;
  let data = "";
  for (let c = 0; c < f.chunks; c++) data += (await db.get(`file:${rec.id}:${index}:${c}`)) || "";
  return { ...f, data };
}

async function deleteFiles(db, rec) {
  if (rec.filesDeleted) return;
  for (let i = 0; i < rec.files.length; i++) {
    for (let c = 0; c < rec.files[i].chunks; c++) await db.del(`file:${rec.id}:${i}:${c}`);
  }
}

export async function deleteRecord(db, rec) {
  if (!rec.filesDeleted) for (let i = 0; i < rec.files.length; i++) {
    for (let c = 0; c < rec.files[i].chunks; c++) await db.del(`file:${rec.id}:${i}:${c}`);
  }
  await db.del("rec:" + rec.id);
  await db.del("sum:" + rec.id);
  await db.del(`usum:${rec.username}:${rec.id}`);
}

// ===== 資料保存期限 =====
// settings = { fileDays, resultDays }：0 或空白 = 不自動刪除
export function checkRetention(fileDays, resultDays) {
  const n = (v) => (v === "" || v === null || v === undefined ? 0 : Number(v));
  const f = n(fileDays), r = n(resultDays);
  for (const v of [f, r]) {
    if (!Number.isInteger(v) || v < 0 || v > 3650) throw new Error("天數請填 1～3650 的整數，或留空表示不自動刪除");
  }
  if (r && (!f || f > r)) throw new Error("檔案的保存天數不能比結果長（結果刪除時，檔案也會一起刪除）");
  return { fileDays: f, resultDays: r };
}

// 刪除過期資料：
//   檔案超過 fileDays 天 → 只刪檔案，保留檢核結果
//   整筆超過 resultDays 天 → 檔案和結果全部刪除
// 紀錄 id 開頭是時間，所以從最舊的往新的掃，掃到還沒過期的就停。
// 「刪檔案」記住上次掃到哪一筆（setting:fileCursor），下次從那裡繼續，不會重複掃已處理過的紀錄。
export async function cleanupRecords(db, { fileDays, resultDays }, now = Date.now(), batch = 200) {
  const counts = { files: 0, records: 0 };
  const cutoff = (days) => "sum:" + String(now - days * DAY).padStart(15, "0");

  if (resultDays) {
    for (;;) {
      const list = Object.values(await db.list({ prefix: "sum:", end: cutoff(resultDays), limit: batch }));
      for (const sum of list) {
        const rec = await db.get("rec:" + sum.id);
        if (rec) await deleteRecord(db, rec);
        else await db.del("sum:" + sum.id);
        counts.records++;
      }
      if (list.length < batch) break;
    }
  }

  if (fileDays) {
    let cursor = (await db.get("setting:fileCursor")) || "";
    for (;;) {
      const opts = { prefix: "sum:", end: cutoff(fileDays), limit: batch };
      if (cursor) opts.start = "sum:" + cursor + "~";
      const list = Object.values(await db.list(opts));
      for (const sum of list) {
        const rec = await db.get("rec:" + sum.id);
        if (rec && !rec.filesDeleted) {
          await deleteFiles(db, rec);
          const when = new Date(now).toISOString();
          await db.put("rec:" + rec.id, { ...rec, filesDeleted: when });
          const s = { ...sum, filesDeleted: when };
          await db.put("sum:" + rec.id, s);
          await db.put(`usum:${rec.username}:${rec.id}`, s);
          counts.files++;
        }
        cursor = sum.id;
      }
      if (list.length) await db.put("setting:fileCursor", cursor);
      if (list.length < batch) break;
    }
  }
  return counts;
}

export async function runCleanup(db, now = Date.now()) {
  const settings = (await db.get("setting:retention")) || { fileDays: 0, resultDays: 0 };
  const counts = await cleanupRecords(db, settings, now);
  if (counts.files || counts.records) {
    await addLog(db, {
      username: "system", name: "系統", action: "依保存期限自動刪除",
      overall: `刪除 ${counts.files} 筆的檔案（保留結果）、${counts.records} 筆整筆紀錄`,
    });
  }
  return counts;
}

// 步驟 5「送」：標記這份送件已交回人資（只記一次）
export async function markSubmitted(db, rec, user) {
  if (rec.submittedAt) return rec;
  const when = new Date().toISOString();
  const updated = { ...rec, submittedAt: when, submittedBy: user.name };
  await db.put("rec:" + rec.id, updated);
  for (const key of ["sum:" + rec.id, `usum:${rec.username}:${rec.id}`]) {
    const sum = await db.get(key);
    if (sum) await db.put(key, { ...sum, submittedAt: when });
  }
  return updated;
}

// 例外放行（只有管理者）：審核不通過，但經核准仍可繼續列印、交回人資
export async function overrideRecord(db, rec, user, reason) {
  const override = { at: new Date().toISOString(), by: user.name, username: user.username, reason };
  const updated = { ...rec, override };
  await db.put("rec:" + rec.id, updated);
  for (const key of ["sum:" + rec.id, `usum:${rec.username}:${rec.id}`]) {
    const sum = await db.get(key);
    if (sum) await db.put(key, { ...sum, override: true });
  }
  return updated;
}
