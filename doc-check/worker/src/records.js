// 檢核紀錄：每次檢核都保存上傳的檔案和結果，作為歷史軌跡。
// 一般使用者只看得到自己的紀錄；管理者看得到全部。只有管理者可以刪除，刪除也會記在使用紀錄裡。
//
// 儲存方式（同一個資料庫）：
//   rec:<id>                  完整紀錄（含檢核結果）
//   sum:<id>                  摘要（列表用）
//   usum:<帳號>:<id>          同一份摘要，依帳號分開，方便列出「我的紀錄」
//   file:<id>:<第幾個檔>:<第幾段>  檔案內容（分段存，每段不超過 1MB）

const CHUNK = 1_000_000;

export const newId = () => String(Date.now()).padStart(15, "0") + Math.random().toString(36).slice(2, 6);

function summaryOf(rec) {
  const r = rec.result;
  const count = (s) => (r ? r.items.filter((i) => i.status === s).length : 0);
  return {
    id: rec.id, time: rec.time, username: rec.username, name: rec.name,
    applicant: r?.applicant_name || "", overall: r ? r.overall : "error",
    fail: count("fail"), warn: count("warn"), fileCount: rec.files.length,
    error: rec.error || "",
  };
}

export async function saveRecord(db, { user, files, note, unit, result, error }) {
  const id = newId();
  const meta = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const data = String(f.data || "");
    const chunks = Math.max(1, Math.ceil(data.length / CHUNK));
    for (let c = 0; c < chunks; c++) await db.put(`file:${id}:${i}:${c}`, data.slice(c * CHUNK, (c + 1) * CHUNK));
    meta.push({ name: String(f.name || "").slice(0, 200), kind: f.kind, media_type: f.media_type || "", size: data.length, chunks });
  }
  const rec = {
    id, time: new Date().toISOString(), username: user.username, name: user.name,
    note: note || "", unit: unit || "", files: meta, result: result || null,
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
  if (!f) return null;
  let data = "";
  for (let c = 0; c < f.chunks; c++) data += (await db.get(`file:${rec.id}:${index}:${c}`)) || "";
  return { ...f, data };
}

export async function deleteRecord(db, rec) {
  for (let i = 0; i < rec.files.length; i++) {
    for (let c = 0; c < rec.files[i].chunks; c++) await db.del(`file:${rec.id}:${i}:${c}`);
  }
  await db.del("rec:" + rec.id);
  await db.del("sum:" + rec.id);
  await db.del(`usum:${rec.username}:${rec.id}`);
}
