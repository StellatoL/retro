// P3 洞察测试：状态漏斗与按周趋势；stats 必须保持 0.5.0 形态不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../lib/config.js";
import { RetroStore } from "../lib/store.js";
import { createQueryService, renderPanelApi } from "../lib/query.js";

function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-p3-"));
  const store = new RetroStore(path.join(dir, "state"));
  const cfg = { ...DEFAULTS, vaultPath: path.join(dir, "vault") };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { store, cfg, service: createQueryService({ store, cfg }) };
}

test("洞察包含漏斗、趋势与 llmUsage，且 stats 与 0.5.0 一致", (t) => {
  const { store, cfg, service } = harness(t);
  store.addMaterial({ sessionId: "s1", kind: "goal-complete", summary: "A" });
  store.addMaterial({ sessionId: "s1", kind: "feedback", summary: "B" });
  store.addCard({ title: "已落库", status: "approved", createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-03T10:00:00.000Z" });
  store.addCard({ title: "已丢弃", status: "discarded", createdAt: "2026-11-02T11:00:00.000Z", updatedAt: "2026-11-02T12:00:00.000Z" });
  store.addCard({ title: "待审", status: "drafted", createdAt: "2026-11-04T10:00:00.000Z" });
  store.addProposal({ id: "p1", kind: "skill", title: "已采纳", status: "adopted", createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z" });

  const snapshot = service.getSnapshot();
  const legacy = renderPanelApi(store, cfg);
  assert.deepEqual(snapshot.stats, legacy.stats, "stats 必须保持 0.5.0 形态");

  assert.equal(snapshot.insights.funnel.captured, 2);
  assert.equal(snapshot.insights.funnel.cards, 3);
  assert.equal(snapshot.insights.funnel.reviewed, 2);
  assert.equal(snapshot.insights.funnel.approved, 1);
  assert.equal(snapshot.insights.funnel.adoptionRate, 0.5);

  const periods = snapshot.insights.trends.map((row) => row.period);
  assert.ok(periods.length >= 1, "应有按周聚合的趋势");
  assert.ok(periods.every((period) => /^\d{4}-W\d{2}$/.test(period)), "趋势周期为 ISO 周格式");
  const totalCreated = snapshot.insights.trends.reduce((sum, row) => sum + row.cardsCreated, 0);
  assert.equal(totalCreated, 3, "趋势应覆盖全部卡片创建");
});

test("没有可审数据时采纳率为 0，趋势为空数组", (t) => {
  const { service } = harness(t);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.insights.funnel.adoptionRate, 0);
  assert.deepEqual(snapshot.insights.trends, []);
  assert.equal(snapshot.insights.llmUsage, null);
});
