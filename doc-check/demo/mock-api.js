// 介面展示版用的「假伺服器」：在瀏覽器裡模擬 worker 的 API，讓人不用部署也能點看登入、紀錄、管理等畫面。
// 資料只存在記憶體，重新整理就重設。由 build-trial.py 打包進預覽頁，正式版不會用到。
(() => {
  const now = () => new Date().toISOString();
  const rid = () => String(Date.now()).padStart(15, "0") + Math.random().toString(36).slice(2, 6);
  const ROLES = { admin: "管理者", user: "使用者" };
  const db = {
    users: {
      admin: { username: "admin", name: "系統管理者", role: "admin", active: true, password: "admin1234", created: now(), lastLogin: null },
      a001: { username: "a001", name: "王小美", role: "user", active: true, password: "abcd1234", created: now(), lastLogin: null },
    },
    sessions: {},
    records: [],
    logs: [],
    settings: { signupCode: "demo", retention: { fileDays: 90, resultDays: 365 } },
    rules: {}, // 單位 -> [{version, text, note, by, updated}]
  };
  for (const unit of ["分公司", "總公司"]) {
    db.rules[unit] = [{ unit, version: 0, text: TRIAL.RULES[unit], note: "預設規則", by: "系統預設", updated: null }];
  }
  const pub = (u) => ({ username: u.username, name: u.name, role: u.role, roleName: ROLES[u.role], active: u.active, created: u.created, lastLogin: u.lastLogin });
  const log = (u, action, overall, extra = {}) => db.logs.unshift({ time: now(), username: u.username, name: u.name, action, overall, ...extra });
  const ok = (data) => ({ status: 200, data });
  const err = (status, error) => ({ status, data: { error } });
  const curRules = (unit) => db.rules[unit].at(-1);
  const summary = (r) => ({
    id: r.id, time: r.time, username: r.username, name: r.name, applicant: r.result?.applicant_name || "",
    overall: r.result ? r.result.overall : "error", fail: r.result ? r.result.items.filter((i) => i.status === "fail").length : 0,
    warn: r.result ? r.result.items.filter((i) => i.status === "warn").length : 0, fileCount: r.files.length,
    submittedAt: r.submittedAt || null,
  });
  const warns = (r) => (r.result?.items || []).filter((i) => i.status === "warn");

  // 預先放兩筆範例紀錄，紀錄頁才不會是空的
  function seed(user, result, daysAgo, submitted) {
    const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
    db.records.push({ id: String(Date.parse(t)).padStart(15, "0") + "seed", time: t, username: user.username, name: user.name,
      unit: "分公司", ruleVersion: 0, note: "", files: [{ name: "範例送件.pdf", kind: "pdf", media_type: "application/pdf", size: 0, data: "" }],
      result, submittedAt: submitted ? t : null, submittedBy: submitted ? user.name : null });
  }

  window.MOCK_SEED = (demoResult) => {
    const passed = { ...demoResult, overall: "pass", headline: "全部通過（範例）", items: demoResult.items.map((i) => ({ ...i, status: "pass", fix: "" })), documents: demoResult.documents.map((d) => ({ ...d, found: true })) };
    seed(db.users.a001, passed, 3, true);
    seed(db.users.a001, demoResult, 1, false);
  };

  window.MOCK_API = async (path, body, token) => {
    await new Promise((r) => setTimeout(r, 150));
    const url = new URL(path, "https://mock.local");
    const p = url.pathname, POST = body !== undefined;
    if (p === "/login" && POST) {
      const u = db.users[String(body.username || "").trim().toLowerCase()];
      if (!u || u.password !== body.password) return err(401, "帳號或密碼錯誤");
      if (!u.active) return err(401, "這個帳號已停用，請洽管理者");
      u.lastLogin = now();
      const t = Math.random().toString(16).slice(2).padEnd(64, "0");
      db.sessions[t] = u.username;
      return ok({ token: t, user: pub(u) });
    }
    if (p === "/register" && POST) {
      if (!db.settings.signupCode) return err(403, "目前尚未開放註冊，請洽管理者");
      if (String(body.code || "").trim() !== db.settings.signupCode) return err(403, "註冊碼不正確，請向管理者確認（展示版的註冊碼是 demo）");
      const username = String(body.username || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,32}$/.test(username)) return err(400, "帳號只能用英文、數字、._-，長度 2～32 字");
      if (db.users[username]) return err(400, "這個帳號已經有人使用，請換一個");
      if (String(body.password || "").length < 8) return err(400, "密碼至少 8 個字元");
      const u = db.users[username] = { username, name: String(body.name || "").trim() || username, role: "user", active: true, password: body.password, created: now(), lastLogin: now() };
      log(u, "註冊帳號", username);
      const t = Math.random().toString(16).slice(2).padEnd(64, "1");
      db.sessions[t] = username;
      return ok({ token: t, user: pub(u) });
    }
    const user = db.users[db.sessions[token]];
    if (!user || !user.active) return err(401, "請先登入");
    const isAdmin = user.role === "admin";

    if (p === "/me") return ok({ user: pub(user) });
    if (p === "/logout") { delete db.sessions[token]; return ok({ ok: true }); }
    if (p === "/password" && POST) {
      if (body.oldPassword !== user.password) return err(400, "目前的密碼不正確");
      if (String(body.newPassword || "").length < 8) return err(400, "密碼至少 8 個字元");
      user.password = body.newPassword;
      for (const [k, v] of Object.entries(db.sessions)) if (v === user.username) delete db.sessions[k];
      return ok({ ok: true });
    }
    if (p === "/checklist") {
      const unit = url.searchParams.get("unit");
      if (!db.rules[unit]) return err(400, "請選擇送件單位（分公司或總公司）");
      return ok({ unit, version: curRules(unit).version, documents: TRIAL.checklistOf(curRules(unit).text) });
    }
    if (p === "/calendar" && !POST) return ok({ years: [] });
    if (p === "/check" && POST) {
      const r = { id: rid(), time: now(), username: user.username, name: user.name, unit: body.unit, ruleVersion: curRules(body.unit).version,
        note: body.note || "", files: body.files.map((f) => ({ ...f, size: f.data.length })), result: body.mockResult };
      db.records.push(r);
      log(user, "檢核", body.mockResult.overall, { record: r.id, applicant: body.mockResult.applicant_name, files: body.files.map((f) => f.name),
        fail: summary(r).fail, warn: summary(r).warn });
      return ok({ ...body.mockResult, record_id: r.id });
    }
    if (p === "/records") {
      const who = isAdmin ? (url.searchParams.get("user") || "").toLowerCase() : user.username;
      const list = db.records.filter((r) => !who || r.username === who).slice().reverse().map(summary);
      return ok({ records: list, more: false });
    }
    const m = p.match(/^\/records\/([0-9a-z]+)(?:\/(files)\/(\d+)|\/(confirm|submit))?$/);
    if (m) {
      const r = db.records.find((x) => x.id === m[1]);
      if (!r || (!isAdmin && r.username !== user.username)) return err(404, "找不到這筆紀錄");
      if (m[2]) {
        const f = r.files[Number(m[3])];
        return f && f.data ? ok({ file: f }) : err(404, "展示用的範例紀錄沒有真的檔案");
      }
      if (m[4] === "confirm") {
        if (r.result.overall === "fail") return err(400, "審核尚未通過，請先修正並重新審核");
        const missing = warns(r).filter((i) => !(body.items || []).includes(i.rule_id));
        if (missing.length) return err(400, "還有需確認的項目沒有勾選：" + missing.map((i) => i.rule_id).join("、"));
        r.confirmations = { at: now(), by: user.name, username: user.username, items: warns(r).map((i) => ({ rule_id: i.rule_id, rule: i.rule, finding: i.finding })) };
        log(user, "確認需確認項目", r.confirmations.items.map((i) => i.rule_id).join("；"), { record: r.id });
        return ok({ confirmations: r.confirmations });
      }
      if (m[4] === "submit") {
        if (!r.result || r.result.overall === "fail") return err(400, "審核尚未通過，請先修正並重新審核");
        if (warns(r).length && !r.confirmations) return err(400, "請先勾選確認所有「需確認」的項目");
        if (!r.submittedAt) { r.submittedAt = now(); r.submittedBy = user.name; log(user, "已交回人資", r.result.applicant_name, { record: r.id }); }
        return ok({ submittedAt: r.submittedAt, submittedBy: r.submittedBy });
      }
      return ok({ record: r });
    }

    if (!isAdmin) return err(403, "只有管理者可以使用這個功能");
    if (p === "/calendar" && POST) return err(400, "展示版不能上傳行事曆（正式版會用 AI 讀取人事行政總處的行事曆）。");
    if (p === "/admin/users" && !POST) return ok({ users: Object.values(db.users).filter((u) => u.username !== "admin").map(pub) });
    if (p === "/admin/users" && POST) {
      const username = String(body.username || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,32}$/.test(username) || username === "admin") return err(400, "帳號只能用英文、數字、._-，長度 2～32 字");
      if (body.create && db.users[username]) return err(400, "這個帳號已經存在");
      if (!body.create && !db.users[username]) return err(400, "找不到這個帳號");
      if ((body.create || body.password) && String(body.password || "").length < 8) return err(400, "密碼至少 8 個字元");
      const u = db.users[username] || (db.users[username] = { username, created: now(), lastLogin: null });
      Object.assign(u, { name: String(body.name || "").trim() || username, role: body.role === "admin" ? "admin" : "user", active: body.active !== false });
      if (body.password) u.password = body.password;
      log(user, body.create ? "新增帳號" : "修改帳號", `${username}（${ROLES[u.role]}${u.active ? "" : "，停用"}）`);
      return ok({ user: pub(u) });
    }
    if (p === "/admin/users/delete" && POST) {
      if (!db.users[body.username] || body.username === "admin") return err(400, "找不到這個帳號");
      delete db.users[body.username];
      log(user, "刪除帳號", body.username);
      return ok({ ok: true });
    }
    if (p === "/admin/settings" && !POST) return ok(db.settings);
    if (p === "/admin/settings" && POST) {
      const code = String(body.signupCode || "").trim();
      if (code && code.length < 4) return err(400, "註冊碼至少 4 個字元");
      db.settings.signupCode = code;
      log(user, code ? "設定註冊碼" : "關閉註冊", "");
      return ok({ signupCode: code });
    }
    if (p === "/admin/retention" && POST) {
      const n = (v) => (v === "" || v == null ? 0 : Number(v));
      const f = n(body.fileDays), r = n(body.resultDays);
      if (![f, r].every((v) => Number.isInteger(v) && v >= 0 && v <= 3650)) return err(400, "天數請填 1～3650 的整數，或留空表示不自動刪除");
      if (r && (!f || f > r)) return err(400, "檔案的保存天數不能比結果長（結果刪除時，檔案也會一起刪除）");
      db.settings.retention = { fileDays: f, resultDays: r };
      log(user, "設定保存期限", `檔案：${f || "不自動刪除"}；結果：${r || "不自動刪除"}`);
      return ok({ retention: db.settings.retention, cleaned: { files: 0, records: 0 } });
    }
    if (p === "/admin/rules" && !POST) {
      const unit = url.searchParams.get("unit");
      if (!db.rules[unit]) return err(400, "請選擇送件單位（分公司或總公司）");
      const v = url.searchParams.get("version");
      if (v !== null) { const r = db.rules[unit].find((x) => x.version === Number(v)); return r ? ok({ rules: r }) : err(404, "找不到這個版本"); }
      return ok({ rules: curRules(unit), history: db.rules[unit].slice().reverse().map(({ text, ...m }) => m) });
    }
    if (p === "/admin/rules" && POST) {
      const text = String(body.text || "").trim();
      if (text.length < 50) return err(400, "規則內容太短，請確認沒有誤刪");
      const list = db.rules[body.unit];
      const r = { unit: body.unit, version: list.at(-1).version + 1, text, note: String(body.note || ""), by: user.name, updated: now() };
      list.push(r);
      log(user, "修改檢核規則", `${body.unit}規則第 ${r.version} 版${r.note ? "：" + r.note : ""}`);
      return ok({ rules: r });
    }
    if (p === "/admin/rules/draft" && POST) return err(400, "展示版不能用 AI 產生規則草稿（需要正式版伺服器）；可以直接在下方編輯區修改後儲存，看看版本紀錄的效果。");
    if (p === "/admin/records/delete" && POST) {
      const i = db.records.findIndex((r) => r.id === body.id);
      if (i < 0) return err(404, "找不到這筆紀錄");
      const [r] = db.records.splice(i, 1);
      log(user, "刪除檢核紀錄", `${r.name} ${r.time.slice(0, 10)}`);
      return ok({ ok: true });
    }
    if (p === "/admin/logs") return ok({ logs: db.logs.slice(0, 200) });
    return err(404, "找不到這個功能");
  };
})();
