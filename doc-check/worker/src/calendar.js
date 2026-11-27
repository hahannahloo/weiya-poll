// 計算「可報到日期」：每週第一個工作日、每月第一個工作日（排除週末與 rules.md 列的國定假日）。
// 日期計算交給程式，比讓 AI 自己算星期幾可靠。

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const DAY = 86400000;

// 從 rules.md 的「國定假日」段落抓出 YYYY-MM-DD
export function parseHolidays(md) {
  const section = md.split(/^##\s*國定假日.*$/m)[1] || "";
  return new Set(section.match(/\d{4}-\d{2}-\d{2}/g) || []);
}

const iso = (d) => d.toISOString().slice(0, 10);

function todayInTaipei(now) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// 回傳文字表格，放進給 AI 的訊息裡
export function reportDateTable(holidays, now = new Date(), daysBefore = 45, daysAfter = 200) {
  const today = todayInTaipei(now);
  const start = new Date(today.getTime() - daysBefore * DAY);
  const end = new Date(today.getTime() + daysAfter * DAY);
  const isWorkday = (d) => d.getUTCDay() % 6 !== 0 && !holidays.has(iso(d));

  const firstOfWeek = new Map(); // 週一的日期 -> 該週第一個工作日
  const firstOfMonth = new Map(); // YYYY-MM -> 該月第一個工作日
  // 從 start 所在月份的 1 號開始算，月初才不會漏算
  const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  for (let d = from; d <= end; d = new Date(d.getTime() + DAY)) {
    if (!isWorkday(d)) continue;
    const monday = iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
    if (!firstOfWeek.has(monday)) firstOfWeek.set(monday, d);
    const ym = iso(d).slice(0, 7);
    if (!firstOfMonth.has(ym)) firstOfMonth.set(ym, d);
  }

  const valid = new Map(); // iso -> 標記
  for (const d of firstOfWeek.values()) valid.set(iso(d), new Set(["週首"]));
  for (const d of firstOfMonth.values()) {
    const k = iso(d);
    if (!valid.has(k)) valid.set(k, new Set());
    valid.get(k).add("月初");
  }

  const byMonth = new Map();
  [...valid.keys()].sort().forEach((k) => {
    const d = new Date(k + "T00:00:00Z");
    if (d < start || d > end) return;
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    const key = `${y}年（民國${y - 1911}年）${m}月`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(`${m}/${day}(${WEEKDAY[d.getUTCDay()]}${[...valid.get(k)].includes("月初") ? "，月初" : ""})`);
  });
  return [...byMonth].map(([k, v]) => `${k}：${v.join("、")}`).join("\n");
}
