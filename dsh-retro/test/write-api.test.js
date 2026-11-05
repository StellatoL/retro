// 受控写接口与事件流测试：默认关闭、动作白名单、乐观锁与 SSE 首帧。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../lib/config.js";
import { ensureDirs, draftCardFiles, readStaging } from "../lib/settler.js";
import { RetroStore } from "../lib/store.js";
import { computeContentHash } from "../lib/guard.js";
import { registerActionApi, registerEventsApi } from "../lib/api.js";

function harness(t, { enableWriteApi = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-write-"));
  const vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg = { ...DEFAULTS, vaultPath: vault, security: { ...DEFAULTS.security, enableWriteApi } };
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, vault, cfg, store };
}

/** 构造一个可注入的宿主上下文，捕获注册的路由。 */
function captureRoute() {
  const holder = { route: null };
  const ctx = {
    inject(names, callback) {
      callback({
        webServer: { register(def) { holder.route = def; return () => {}; } },
        effect(fn) { fn(); }
      });
      return { dispose() {} };
    }
  };
  return { ctx, holder };
}

/** 构造 JSON 请求替身。 */
function jsonRequest(payload, method = "POST") {
  const req = new EventEmitter();
  req.method = method;
  req.destroy = () => {};
  setImmediate(() => {
    if (payload !== undefined) req.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
    req.emit("end");
  });
  return req;
}

function captureResponse() {
  const res = new EventEmitter();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (body) => { res.body = body; };
  return res;
}

test("默认配置下写接口一律返回 403 RETRO_WRITE_DISABLED", async (t) => {
  const { cfg, store, dir } = harness(t);
  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });
  const res = captureResponse();
  await holder.route.handler(jsonRequest({ action: "card.review", id: "x" }), res);
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, "RETRO_WRITE_DISABLED");
});

test("开启后在白名单内的 card.review 与命令路径行为一致", async (t) => {
  const { cfg, store, vault, dir } = harness(t, { enableWriteApi: true });
  const card = store.addCard({ sessionIds: ["s1"], title: "写接口复盘", source: "test" });
  const { relPath } = draftCardFiles(cfg, store, card, { markdown: "## 关键经验\n- HTTP 与 CLI 同源", questions: [] });
  const expectedHash = computeContentHash(readStaging(cfg, relPath));
  const revBefore = store.getRev();

  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });
  const res = captureResponse();
  await holder.route.handler(jsonRequest({
    action: "card.review",
    id: card.id,
    subAction: "keep",
    targetDir: "Index/03_Full_Notes/04_Retro",
    expectedHash
  }), res);

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(body.rev > revBefore);
  assert.equal(body.result.status, "approved");
  assert.equal(store.getCard(card.id).status, "approved");
  assert.ok(store.listAudit(5).some((row) => row.actor === "web:user"), "审计必须记录 web:user");
  assert.ok(store.listEntries().length === 1, "落库同时生成经验条目草稿");
  assert.ok(vault);
});

test("expectedHash 不一致时返回 409，且不修改卡片状态", async (t) => {
  const { cfg, store, dir } = harness(t, { enableWriteApi: true });
  const card = store.addCard({ title: "冲突卡片", source: "test" });
  draftCardFiles(cfg, store, card, { markdown: "x" });
  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });
  const res = captureResponse();
  await holder.route.handler(jsonRequest({
    action: "card.review",
    id: card.id,
    subAction: "keep",
    expectedHash: "0000000000000000"
  }), res);
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).error.code, "RETRO_CONFLICT_HASH");
  assert.equal(store.getCard(card.id).status, "drafted");
});

test("非白名单动作与非 POST 方法被拒绝", async (t) => {
  const { cfg, store, dir } = harness(t, { enableWriteApi: true });
  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });

  const notAllowed = captureResponse();
  await holder.route.handler(jsonRequest({ action: "blog.publish", slug: "x" }), notAllowed);
  assert.equal(notAllowed.status, 400);
  assert.equal(JSON.parse(notAllowed.body).error.code, "RETRO_ACTION_NOT_ALLOWED");

  const wrongMethod = captureResponse();
  const req = jsonRequest(undefined, "GET");
  await holder.route.handler(req, wrongMethod);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
});

test("SSE 路由下发防缓冲响应头与首帧版本号", async (t) => {
  const { cfg, store } = harness(t);
  store.addCard({ title: "事件卡片" });
  const rev = store.getRev();
  const { ctx, holder } = captureRoute();
  registerEventsApi(ctx, store, cfg, { pollMs: 5, heartbeatMs: 100000 });

  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.ended = true; };
  const req = new EventEmitter();
  req.method = "GET";

  const pending = holder.route.handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["content-encoding"], "identity", "必须显式声明 identity 以防 gzip 缓冲");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.chunks[0].includes(`"rev":${rev}`), "首帧必须立即下发当前版本");

  // 状态变化后应推送新的 rev
  store.addCard({ title: "新卡片" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(res.chunks.some((chunk) => chunk.includes('"topic":"change"')), "状态变化应推送变更帧");

  // 连接关闭后处理器结束且定时器被清理
  res.emit("close");
  await pending;
  assert.equal(res.ended, true);
});
