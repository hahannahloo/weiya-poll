// 帳號與登入：密碼加鹽雜湊後才儲存，登入後發一張 7 天有效的登入憑證。
// 內建管理者帳號 admin，密碼是 Cloudflare 上設定的 ADMIN_PASSWORD（不存在資料庫裡，不能刪除）。

const ITERATIONS = 10000;
const SESSION_DAYS = 7;
const MAX_FAILS = 5;          // 連續輸錯幾次就鎖定
const LOCK_MINUTES = 15;
export const ROLES = { admin: "管理者", user: "一般使用者" };
export const BUILTIN_ADMIN = "admin";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITERATIONS },
    key,
    256,
  );
  return hex(bits);
}

function sameText(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export function validUsername(u) {
  return typeof u === "string" && /^[A-Za-z0-9._-]{2,32}$/.test(u);
}

export function checkPassword(p) {
  if (typeof p !== "string" || p.length < 8) return "密碼至少 8 個字元";
  if (p.length > 100) return "密碼太長";
  return null;
}

export async function newPasswordRecord(password) {
  const salt = randomHex(16);
  return { salt, hash: await hashPassword(password, salt) };
}

const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, roleName: ROLES[u.role], active: u.active !== false, created: u.created, lastLogin: u.lastLogin || null });
export { publicUser };

// 登入：成功回傳 { token, user }，失敗丟出錯誤訊息
export async function login(db, env, username, password) {
  username = String(username || "").trim().toLowerCase();
  const failKey = "fail:" + username;
  const fail = (await db.get(failKey)) || { count: 0, until: 0 };
  if (fail.until > Date.now()) {
    const min = Math.ceil((fail.until - Date.now()) / 60000);
    throw new Error(`密碼錯誤太多次，請 ${min} 分鐘後再試`);
  }

  let user = null;
  if (username === BUILTIN_ADMIN) {
    if (env.ADMIN_PASSWORD && sameText(password, env.ADMIN_PASSWORD)) {
      user = { username: BUILTIN_ADMIN, name: "系統管理者", role: "admin", active: true, created: null };
    }
  } else {
    const rec = await db.get("user:" + username);
    if (rec && sameText(await hashPassword(String(password || ""), rec.salt), rec.hash)) user = rec;
  }

  if (!user) {
    const count = fail.count + 1;
    await db.put(failKey, count >= MAX_FAILS ? { count: 0, until: Date.now() + LOCK_MINUTES * 60000 } : { count, until: 0 });
    throw new Error(count >= MAX_FAILS ? `密碼錯誤太多次，帳號鎖定 ${LOCK_MINUTES} 分鐘` : "帳號或密碼錯誤");
  }
  if (user.active === false) throw new Error("這個帳號已停用，請洽管理者");

  await db.del(failKey);
  if (username !== BUILTIN_ADMIN) await db.put("user:" + username, { ...user, lastLogin: new Date().toISOString() });
  const token = randomHex(32);
  await db.put("session:" + token, { username, expires: Date.now() + SESSION_DAYS * 86400000 });
  return { token, user: publicUser(user) };
}

// 從 Authorization 標頭找出目前登入的使用者；沒登入或已停用回傳 null
export async function currentUser(db, request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer ([0-9a-f]{64})$/);
  if (!m) return null;
  const s = await db.get("session:" + m[1]);
  if (!s || s.expires < Date.now()) return null;
  if (s.username === BUILTIN_ADMIN) {
    return { username: BUILTIN_ADMIN, name: "系統管理者", role: "admin", active: true, token: m[1] };
  }
  const u = await db.get("user:" + s.username);
  if (!u || u.active === false) return null;
  return { ...publicUser(u), token: m[1] };
}

// 停用或刪除帳號、重設密碼時，讓這個人所有已登入的裝置失效
export async function dropSessions(db, username) {
  const all = await db.list({ prefix: "session:" });
  for (const [k, v] of Object.entries(all)) {
    if (v.username === username || v.expires < Date.now()) await db.del(k);
  }
}
