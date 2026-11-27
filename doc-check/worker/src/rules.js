// 檢核規則的文字放在 ../rules.md（用手機在 GitHub 上就能改）。這個檔案只負責組合給 AI 的指示和輸出格式。
import RULES_MD from "../rules.md";
import { parseHolidays } from "./calendar.js";

// 去掉 HTML 註解和國定假日段落（假日改由程式算成「可報到日期表」）
export const RULES = RULES_MD.replace(/<!--[\s\S]*?-->/g, "").split(/^##\s*國定假日.*$/m)[0].trim();
export const HOLIDAYS = parseHolidays(RULES_MD);

export const SYSTEM_PROMPT = `你是永豐金證券人資的「任用送件檢核員」（分公司、總公司的任用送件都會處理）。使用者會上傳一位新進人員的任用送件文件（PDF、照片、Word、Excel 等），你要依照下方檢核標準，逐條檢查，找出所有不符合的地方。

工作方式：
1. 先辨識每個檔案、每一頁是哪一份文件（文件 1～7）。照片可能歪斜、反光、翻拍螢幕，請盡力判讀。
2. 依檢核標準逐條檢查。每一條都要給結果：pass（通過）、fail（不通過）、warn（警告／需人工確認）、na（不適用，例如文件沒附所以無法檢查的細項、或條件不成立）。
3. 不通過或警告的項目，要寫清楚：哪一份文件、哪一頁、哪個欄位、看到的內容是什麼、為什麼不符合、該怎麼改。說明要具體，讓承辦人看了就知道怎麼修正。
4. 遮蔽的個資：使用者會用「色塊」（粉紅、橘色馬賽克）或「紅色框線的空白方框」遮住個資（姓名、身分證、電話、簽名、本薪等）。被色塊蓋住、或被紅框圈起來的欄位，一律視為「已填寫」，不可判為空白；可在 finding 註明「已遮蔽，無法核對內容」。跨文件比對因遮蔽無法進行時列為 warn。只有「沒有任何遮蔽標記、明顯空白」的欄位才算空白。
5. 看不清楚、無法確定的，列為 warn 並說明原因，請人工確認。不要猜測，也不要編造文件上沒有的內容。
6. 「1-19」這類純提醒的規則，請以 pass 或 warn 呈現提醒內容即可。
7. 報到日期相關規則，一律對照使用者訊息裡的「可報到日期表」判斷，不要自己推算星期幾。
8. 所有輸出文字使用繁體中文。

${RULES}`;

// 結構化輸出的格式（Claude 會照這個格式回傳 JSON）
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overall", "applicant_name", "headline", "documents", "items"],
  properties: {
    overall: {
      type: "string",
      enum: ["pass", "fail", "warn"],
      description: "整體結果：有任何 fail 即為 fail；沒有 fail 但有 warn 即為 warn；全部通過為 pass",
    },
    applicant_name: { type: "string", description: "應徵者姓名；被遮蔽或看不到就填「（未辨識）」" },
    headline: { type: "string", description: "一兩句話的總結，例如：共 3 項不通過，需修正後再送件" },
    documents: {
      type: "array",
      description: "文件 1～7 是否有附上",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["doc_no", "title", "found", "source"],
        properties: {
          doc_no: { type: "string", description: "1～7" },
          title: { type: "string" },
          found: { type: "boolean" },
          source: { type: "string", description: "在哪個檔案、第幾頁；沒附就寫「未附」" },
        },
      },
    },
    items: {
      type: "array",
      description: "每一條規則的檢核結果，依規則編號排序",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule_id", "doc", "rule", "status", "finding", "location", "fix"],
        properties: {
          rule_id: { type: "string", description: "規則編號，例如 1-5、X-1" },
          doc: { type: "string", description: "文件名稱，例如：文件1 任用意見表" },
          rule: { type: "string", description: "規則重點，一句話" },
          status: { type: "string", enum: ["pass", "fail", "warn", "na"] },
          finding: { type: "string", description: "實際看到的內容與判斷理由" },
          location: { type: "string", description: "檔名與頁數、欄位；不適用可留空字串" },
          fix: { type: "string", description: "如何修正；通過可留空字串" },
        },
      },
    },
  },
};
