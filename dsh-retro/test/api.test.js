// 验证面板快照、HTTP 方法约束与路由卸载。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

import { renderPanelApi, registerPanelApi } from "../lib/api.js";
import { RetroStore } from "../lib/store.js";

function seeded() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-api-"));
  const store = new RetroStore(dir);
  store.addCard({ sessionIds: ["s1"], title: "草稿 A", status: "drafted", stagingPath: "x.md", source: "command" });
  store.addCard({ sessionIds: ["s2"], title: "已落库", status: "approved", vaultNote: "y.md", source: "command" });
  store.addEntry({ title: "条目 1", status: "drafted" });
  store.addEntry({ title: "条目 2", status: "approved" });
  store.addProposal({ id: "p1", kind: "skill", title: "提案 1", status: "pending" });
  store.addProposal({ id: "p2", kind: "retro-suggest", title: "建议", status: "pending", sessionId: "s1" });
  store.addPublish({ slug: "post-1", title: "文章", status: "published" });
  store.addMaterial({ sessionId: "s1", kind: "goal-complete", summary: "完成", importance: 3 });
  store.audit({ actor: "test", action: "x", target: "y", ok: true });
  store.updateMeta({ lastWeeklyCheck: new Date().toISOString(), weeklyCount: 1 });
  return { dir, store };
}

test("renderPanelApi produces the panel snapshot", () => {
  const { dir, store } = seeded();
  const cfg = { vaultPath: "C:/vaults/Obsidian_Stw", stagingDir: "Index/06_Retro/_retro", entriesDir: "Index/06_Retro/_entries" };
  const api = renderPanelApi(store, cfg);
  assert.ok(api.generatedAt);
  assert.equal(api.vaultName, "Obsidian_Stw"); // obsidian:// URI 用
  assert.equal(api.stats.cards, 2);
  assert.equal(api.stats.draftedCards, 1);
  assert.equal(api.stats.entries, 2);
  assert.equal(api.stats.draftedEntries, 1);
  assert.equal(api.stats.proposals, 2);
  assert.equal(api.stats.pendingProposals, 1); // retro-suggest 不计入待采纳
  assert.equal(api.stats.publish, 1);
  assert.equal(api.stats.publishedPosts, 1);
  assert.equal(api.stats.materials, 1);
  assert.equal(api.stats.weeklyCount, 1);
  // queue（note = vault 相对路径，供 Obsidian 打开）
  assert.equal(api.queue.cards.length, 1);
  assert.equal(api.queue.cards[0].note, "Index/06_Retro/_retro/x.md");
  assert.equal(api.queue.entries.length, 1);
  assert.equal(api.queue.proposals.length, 1);
  assert.equal(api.queue.proposals[0].kind, "skill");
  // 最近落库（可打开）
  assert.equal(api.recentApproved.length, 1);
  assert.equal(api.recentApproved[0].note, "y.md");
  // 审计记录
  assert.ok(api.recentAudit.length >= 1);
  rmSync(dir, { recursive: true, force: true });
});

test("renderPanelApi handles an empty store", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-api-"));
  const api = renderPanelApi(new RetroStore(dir));
  assert.equal(api.stats.cards, 0);
  assert.deepEqual(api.queue.cards, []);
  assert.deepEqual(api.recentAudit, []);
  rmSync(dir, { recursive: true, force: true });
});

test("面板最近落库列表保留最新的五张卡片", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RetroStore(dir);
  for (let i = 0; i < 7; i++) store.addCard({ title: `卡片 ${i}`, status: "approved", vaultNote: `${i}.md` });
  assert.deepEqual(renderPanelApi(store).recentApproved.map((card) => card.title), ["卡片 6", "卡片 5", "卡片 4", "卡片 3", "卡片 2"]);
});

test("没有暂存文件的卡片不生成无效 Obsidian 路径", (t) => {
  const { dir, store } = seeded();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  store.addCard({ title: "待生成", status: "drafted" });
  assert.equal(renderPanelApi(store, { stagingDir: "Index/_retro" }).queue.cards[0].note, null);
});

test("面板路由实现 GET 和 HEAD，拒绝写入方法并保留卸载回调", async (t) => {
  const { dir, store } = seeded();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let route;
  let dispose;
  let disposed = false;
  const fiber = {};
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ["webServer"]);
      callback({
        webServer: { register(def) { route = def; return () => { disposed = true; }; } },
        effect(fn) { dispose = fn(); }
      });
      return fiber;
    }
  };
  assert.equal(registerPanelApi(ctx, store), fiber);
  assert.equal(route.path, "/retro/api");
  for (const method of ["GET", "HEAD", "POST"]) {
    const response = {};
    await route.handler({ method }, {
      writeHead(status, headers) { Object.assign(response, { status, headers }); },
      end(body) { response.body = body; }
    });
    if (method === "POST") {
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, "GET, HEAD");
    } else {
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      if (method === "HEAD") assert.equal(response.body, undefined);
      else assert.equal(JSON.parse(response.body).stats.cards, 2);
    }
  }
  dispose();
  assert.equal(disposed, true);
});
