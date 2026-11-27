// AI 回傳後，用程式再檢查一次有沒有漏：
//   1. 規則全文裡的每一條（例如 1-5、3-12a、X-1）都要有結果，沒有就補「需確認」
//   2. 每個上傳的檔案都要對應到某份文件，沒有就補「需確認」
// 補上的項目會讓整體結果至少是「需確認」，承辦人在步驟 4 要逐項確認。

export function ruleIdsOf(text) {
  const list = [];
  for (const m of String(text).matchAll(/^((?:\d+|[A-Z])-\d+[a-z]?)\s+(.+)$/gm)) {
    list.push({ id: m[1], title: m[2].split(/[：:]/)[0].trim().slice(0, 40) });
  }
  return list;
}

export function ensureCoverage(result, rulesText, files) {
  const added = [];
  const seen = new Set((result.items || []).map((i) => String(i.rule_id).trim()));
  for (const r of ruleIdsOf(rulesText)) {
    if (seen.has(r.id)) continue;
    added.push({ rule_id: r.id, doc: "（系統檢查）", rule: r.title, status: "warn",
      finding: "AI 沒有回報這一條的檢核結果，可能漏看了。", location: "", fix: "請人工確認這一條是否符合規定。" });
  }
  const mentioned = JSON.stringify([result.documents, (result.items || []).map((i) => [i.location, i.finding])]);
  files.forEach((f, i) => {
    if (f.embedded) return; // Word 裡抽出的圖片不用單獨對應
    const name = String(f.name || "");
    const n = i + 1;
    if ((name && mentioned.includes(name)) || mentioned.includes(`檔案 ${n}`) || mentioned.includes(`檔案${n}`)) return;
    added.push({ rule_id: `F-${n}`, doc: "（系統檢查）", rule: "上傳的檔案沒有被辨識", status: "warn",
      finding: `「${name}」沒有對應到任何必備文件，可能沒被讀到，或不是這次需要的文件。`, location: name, fix: "請確認這個檔案的內容是否已被檢核；必要時重新上傳（建議用 PDF）。" });
  });
  if (!added.length) return result;
  const items = [...(result.items || []), ...added];
  return {
    ...result, items,
    overall: result.overall === "pass" ? "warn" : result.overall,
    headline: `${result.headline}（系統另外補了 ${added.length} 項需人工確認）`,
    coverageAdded: added.length,
  };
}
