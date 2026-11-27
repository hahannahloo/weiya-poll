// 讀取人事行政總處行事曆用的 AI 指示、輸出格式與檢查。

export const CALENDAR_PROMPT = `你負責讀取「行政院人事行政總處」公告的政府行政機關辦公日曆表（行事曆）。檔案可能是 PDF、圖片、Excel 或 CSV（開放資料 CSV 通常有「西元日期、星期、是否放假、備註」欄位，是否放假為 2 代表放假）。

請整理出：
1. holidays：週一到週五之中「放假」的日子（國定假日、補假、調整放假、春節等）。週六、週日的一般休假不用列。
2. makeup_workdays：週六或週日卻「補行上班」的日子。
日期一律轉成西元 YYYY-MM-DD（民國年 + 1911 = 西元年）。name 填假日名稱或備註。
只列檔案中明確看得到的日期，不要自行推算或補上檔案裡沒有的年份。看不清楚的寫在 notes。`;

export const CALENDAR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["years", "notes"],
  properties: {
    years: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["year", "holidays", "makeup_workdays"],
        properties: {
          year: { type: "integer", description: "西元年" },
          holidays: { type: "array", items: dateItem() },
          makeup_workdays: { type: "array", items: dateItem() },
        },
      },
    },
    notes: { type: "string", description: "看不清楚或需要人工確認的地方；沒有就留空字串" },
  },
};

function dateItem() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["date", "name"],
    properties: { date: { type: "string", description: "YYYY-MM-DD" }, name: { type: "string" } },
  };
}

// 用程式再檢查一次 AI 讀出來的日期：格式正確、年份相符、放假日在平日、補班日在週末
export function cleanCalendar(raw) {
  const valid = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  };
  const day = (s) => new Date(s + "T00:00:00Z").getUTCDay();
  const pick = (list, year, wantWeekend) => {
    const seen = new Map();
    for (const h of list || []) {
      const date = String(h.date || "").trim();
      if (!valid(date) || Number(date.slice(0, 4)) !== year) continue;
      if ((day(date) % 6 === 0) !== wantWeekend) continue;
      seen.set(date, { date, name: String(h.name || "").slice(0, 50) });
    }
    return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
  };
  return (raw.years || [])
    .filter((y) => Number.isInteger(y.year) && y.year >= 2020 && y.year <= 2100)
    .map((y) => ({ year: y.year, holidays: pick(y.holidays, y.year, false), workdays: pick(y.makeup_workdays, y.year, true) }))
    .filter((y) => y.holidays.length);
}
