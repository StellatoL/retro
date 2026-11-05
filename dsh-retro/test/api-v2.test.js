// 读取端点 v2 测试：兼容快照、sinceRev 轻量响应、过滤分页与实体详情。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../lib/config.js";
import { ensureDirs, writeStaging } from "../lib/settler.js";
import { RetroStore } from "../lib/store.js";
import { createQueryService, renderPanelApi } from "../lib/query.js";
import { registerDetailApi } from "../lib/api.js";

function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-api-v2-"));
  const vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  mkdirSync(path.join(vault, "Index", "03_Full_Notes"), { recursive: true });
  const cfg = { ...DEFAULTS, vaultPath: vault };
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, vault, cfg, store, service: createQueryService({ store, cfg }) };
}

test("不带参数的快照与 0.5.0 字段完全一致，并追加 rev/writeApiEnabled", (t) => {
  const { cfg, store, service } = harness(t);
  store.addCard({ title: "草稿", status: "drafted", stagingPath: "a.md" });
  store.addEntry({ title: "条目", status: "drafted" });
  const legacy = renderPanelApi(store, cfg);
  const snapshot = service.getSnapshot();
  for (const key of Object.keys(legacy)) {
    assert.ok(Object.hasOwn(snapshot, key), `缺少既有字段：${key}`);
  }
  assert.deepEqual(snapshot.stats, legacy.stats);
  assert.deepEqual(snapshot.queue, legacy.queue);
  assert.equal(typeof snapshot.rev, "number");
  assert.equal(snapshot.writeApiEnabled, false);
  assert.equal(snapshot.page, undefined, "不带参数时不应出现分页字段");
});

test("sinceRev 命中时只返回 unchanged，避免整包序列化", (t) => {
  const { store, service } = harness(t);
  store.addCard({ title: "x" });
  const rev = store.getRev();
  const light = service.getSnapshot({ sinceRev: String(rev) });
  assert.deepEqual(light, { unchanged: true, rev });
  const full = service.getSnapshot({ sinceRev: String(rev - 1) });
  assert.equal(full.unchanged, undefined);
  assert.ok(Array.isArray(full.queue.cards));
});

test("按状态过滤、关键字搜索与游标分页", (t) => {
  const { store, service } = harness(t);
  for (let i = 0; i < 5; i += 1) {
    store.addCard({ title: `并发排查 ${i}`, status: i % 2 === 0 ? "drafted" : "approved" });
  }
  store.addCard({ title: "无关内容", status: "drafted" });

  const drafted = service.getSnapshot({ status: "drafted", limit: "2" });
  assert.equal(drafted.page.resource, "cards");
  assert.equal(drafted.page.items.length, 2);
  assert.ok(drafted.page.items.every((card) => card.status === "drafted"));
  assert.ok(drafted.page.nextCursor, "存在更多数据时应返回游标");

  const nextPage = service.getSnapshot({ status: "drafted", limit: "2", cursor: drafted.page.nextCursor });
  assert.equal(nextPage.page.items.length, 2);
  assert.equal(nextPage.page.nextCursor, null, "取完剩余数据后不再返回游标");

  const searched = service.getSnapshot({ q: "并发" });
  assert.ok(searched.page.items.length >= 1);
  assert.ok(searched.page.items.every((card) => card.title.includes("并发")));
  assert.ok(!searched.page.items.some((card) => card.title === "无关内容"));
});

test("卡片详情返回暂存 Markdown 与内容哈希", (t) => {
  const { cfg, store, service } = harness(t);
  const card = store.addCard({ title: "详情卡片", status: "drafted" });
  writeStaging(cfg, "detail.md", "# 详情卡片\n\n## 行动项\n- 完成\n", { store, actor: "test" });
  store.updateCard(card.id, { stagingPath: "detail.md" });

  const detail = service.getEntityDetail({ type: "card", id: card.id });
  assert.equal(detail.ok, true);
  assert.equal(detail.meta.title, "详情卡片");
  assert.ok(detail.rawMarkdown.includes("## 行动项"));
  assert.match(detail.contentHash, /^[0-9a-f]{16}$/);
});

test("笔记详情默认仅允许插件目录，越界与穿越分别报错", (t) => {
  const { vault, service } = harness(t);
  writeFileSync(path.join(vault, "Index", "03_Full_Notes", "b.md"), "正文", "utf8");
  mkdirSync(path.join(vault, "Index", "06_Retro", "_retro"), { recursive: true });
  writeFileSync(path.join(vault, "Index", "06_Retro", "_retro", "a.md"), "插件内笔记", "utf8");

  const allowed = service.getEntityDetail({ type: "note", id: "Index/06_Retro/_retro/a.md" });
  assert.equal(allowed.rawMarkdown, "插件内笔记");
  assert.equal(allowed.truncated, false);

  assert.throws(
    () => service.getEntityDetail({ type: "note", id: "Index/03_Full_Notes/b.md" }),
    (error) => error.code === "RETRO_NOTE_SCOPE_DENIED"
  );
  assert.throws(
    () => service.getEntityDetail({ type: "note", id: "../../secret.md" }),
    (error) => error.code === "RETRO_PATH_OUT_OF_BOUNDS"
  );
});

test("未知详情类型返回 400 错误码", (t) => {
  const { service } = harness(t);
  assert.throws(
    () => service.getEntityDetail({ type: "unknown", id: "x" }),
    (error) => error.code === "RETRO_BAD_REQUEST" && error.status === 400
  );
});

test("详情路由只接受 GET/HEAD，并把错误序列化为统一契约", async (t) => {
  const { store, cfg, service } = harness(t);
  let route;
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ["webServer"]);
      callback({
        webServer: { register(def) { route = def; return () => {}; } },
        effect(fn) { fn(); }
      });
      return { dispose() {} };
    }
  };
  registerDetailApi(ctx, store, cfg);
  assert.equal(route.path, "/retro/detail");
  assert.ok(service);

  const call = async (method, url) => {
    const response = {};
    await route.handler({ method, url }, {
      writeHead(status, headers) { Object.assign(response, { status, headers }); },
      end(body) { response.body = body; }
    });
    return response;
  };
  const rejected = await call("POST", "/retro/detail?type=card&id=x");
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.allow, "GET, HEAD");

  const missing = await call("GET", "/retro/detail?type=card&id=nope");
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error.code, "RETRO_ENTITY_NOT_FOUND");
  assert.equal(missing.headers["cache-control"], "no-store");
});
