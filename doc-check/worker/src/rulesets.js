// 檢核規則（分公司、總公司各一套），存在資料庫，每次儲存都是新版本。
// 資料庫還沒有任何版本時，用 rules/ 資料夾裡的預設規則當第 1 版。
//
//   ruleset:<單位>              目前版本（全文）
//   rulever:<單位>:<版本號>      歷史版本（全文），版本號補零方便排序
import BRANCH from "../rules/branch.md";
import HEAD_OFFICE from "../rules/head-office.md";

export const UNITS = ["分公司", "總公司"];
const DEFAULTS = { 分公司: BRANCH, 總公司: HEAD_OFFICE };
const verKey = (unit, v) => `rulever:${unit}:${String(v).padStart(6, "0")}`;

export async function currentRules(db, unit) {
  if (!UNITS.includes(unit)) throw new Error("請選擇送件單位（分公司或總公司）");
  const cur = await db.get("ruleset:" + unit);
  if (cur) return cur;
  return { unit, version: 0, text: DEFAULTS[unit].trim(), updated: null, by: "系統預設", note: "預設規則" };
}

export async function saveRules(db, unit, text, note, user) {
  if (!UNITS.includes(unit)) throw new Error("送件單位不正確");
  text = String(text || "").trim();
  if (text.length < 50) throw new Error("規則內容太短，請確認沒有誤刪");
  if (text.length > 60000) throw new Error("規則內容太長（上限 6 萬字）");
  const cur = await currentRules(db, unit);
  if (cur.version === 0) await db.put(verKey(unit, 0), cur); // 保留預設版，之後可以還原
  const rec = {
    unit, version: cur.version + 1, text,
    note: String(note || "").trim().slice(0, 200),
    updated: new Date().toISOString(), by: user.name, username: user.username,
  };
  await db.put("ruleset:" + unit, rec);
  await db.put(verKey(unit, rec.version), rec);
  return rec;
}

export async function ruleHistory(db, unit) {
  const list = Object.values(await db.list({ prefix: `rulever:${unit}:`, reverse: true, limit: 50 }));
  return list.map(({ text, ...meta }) => ({ ...meta, length: text.length }));
}

export async function ruleVersion(db, unit, version) {
  if (!UNITS.includes(unit)) return null;
  if (Number(version) === 0 && !(await db.get(verKey(unit, 0)))) return currentRules(db, unit).then((r) => (r.version === 0 ? r : null));
  return (await db.get(verKey(unit, Number(version)))) || null;
}

// 從規則全文讀出必備文件清單（「## 文件 N：名稱（說明）」標題），給上傳頁顯示
export function checklistOf(text) {
  const list = [];
  for (const m of String(text).matchAll(/^##\s*文件\s*([0-9０-９]+)\s*[：:]\s*(.+)$/gm)) {
    list.push({ no: m[1], title: m[2].replace(/（[^）]*）|\([^)]*\)/g, "").trim() || m[2].trim(), detail: m[2].trim() });
  }
  return list;
}
