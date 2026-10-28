// 尾牙投票的即時伺服器：所有手機、大螢幕、主持人都用 WebSocket 連到同一個 Durable Object。
// 票數只是暫存，主持人按「清除本題票數」就會刪掉。
import { DurableObject } from "cloudflare:workers";

const CORS = { "Access-Control-Allow-Origin": "*" };
const MAX_Q = 100;
const MAX_OPT = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("請用 WebSocket 連線", { status: 426, headers: CORS });
      }
      const room = env.POLL.get(env.POLL.idFromName("main"));
      return room.fetch(request);
    }
    return new Response("尾牙投票伺服器運作中 ✅", {
      headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
    });
  },
};

export class Poll extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = null;
    this.votes = new Map(); // 題號 -> { 裝置代碼: 選項 }
    this.timer = null;
    // 手機的保持連線訊息直接回覆，不用喚醒程式
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  load() {
    if (!this.ready) {
      this.ready = (async () => {
        this.state = (await this.ctx.storage.get("state")) || { current: 0, reveal: true };
      })();
    }
    return this.ready;
  }

  async votesFor(q) {
    if (!this.votes.has(q)) this.votes.set(q, (await this.ctx.storage.get("v:" + q)) || {});
    return this.votes.get(q);
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "hello") {
      ws.serializeAttachment({ dev: String(m.dev || "").slice(0, 64) });
      await this.sendSnap([ws]);
      return;
    }

    if (m.t === "vote") {
      const dev = (ws.deserializeAttachment() || {}).dev;
      const q = m.q, opt = m.opt;
      if (!dev || q !== this.state.current || !Number.isInteger(opt) || opt < 0 || opt >= MAX_OPT) return;
      const v = await this.votesFor(q);
      if (v[dev] === opt) return;
      v[dev] = opt;
      await this.ctx.storage.put("v:" + q, v);
      this.scheduleBroadcast();
      return;
    }

    if (m.t === "state" && m.patch && typeof m.patch === "object") {
      const p = m.patch;
      if (Number.isInteger(p.current) && p.current >= 0 && p.current < MAX_Q) this.state.current = p.current;
      if (typeof p.reveal === "boolean") this.state.reveal = p.reveal;
      await this.ctx.storage.put("state", this.state);
      await this.sendSnap(this.ctx.getWebSockets());
      return;
    }

    if (m.t === "reset" && Number.isInteger(m.q) && m.q >= 0 && m.q < MAX_Q) {
      this.votes.set(m.q, {});
      await this.ctx.storage.delete("v:" + m.q);
      await this.sendSnap(this.ctx.getWebSockets());
    }
  }

  // 很多人同時投票時，最多每 0.15 秒推送一次結果
  scheduleBroadcast() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sendSnap(this.ctx.getWebSockets());
    }, 150);
  }

  async sendSnap(sockets) {
    await this.load();
    const q = this.state.current;
    const v = await this.votesFor(q);
    const counts = [];
    for (const k in v) counts[v[k]] = (counts[v[k]] || 0) + 1;
    for (let i = 0; i < counts.length; i++) counts[i] = counts[i] || 0;
    const base = { t: "snap", state: this.state, tally: { q, counts } };
    for (const ws of sockets) {
      const dev = (ws.deserializeAttachment() || {}).dev;
      try { ws.send(JSON.stringify({ ...base, mine: dev && dev in v ? v[dev] : null })); } catch {}
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
  }
}
