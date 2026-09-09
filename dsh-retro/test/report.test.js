// 静态 HTML 报告渲染测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

import { renderReport } from "../lib/report.js";
import { RetroStore } from "../lib/store.js";

function seededStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-rpt-"));
  const store = new RetroStore(dir);
  store.addMaterial({ sessionId: "s1", kind: "goal-complete", summary: "完成 X", importance: 3 });
  store.addCard({ sessionIds: ["s1"], title: "复盘 A", status: "drafted", stagingPath: "rc-1.md", source: "command" });
  store.addCard({ sessionIds: ["s2"], title: "复盘 B", status: "approved", vaultNote: "03_Full_Notes/B.md", source: "command" });
  store.addEntry({ title: "经验 1", status: "approved", source: "card", notePath: "经验库/经验 1.md", tags: ["x"] });
  store.addProposal({ id: "prop-1", kind: "skill", title: "补规则", status: "pending", reason: "理由" });
  store.addPublish({ slug: "post-1", title: "文章", status: "drafted" });
  store.audit({ actor: "test", action: "x", target: "y", ok: true });
  store.updateMeta({ lastWeeklyCheck: new Date().toISOString(), weeklyCount: 2 });
  return { dir, store };
}

test("renderReport produces a complete self-contained dashboard", () => {
  const { dir, store } = seededStore();
  const html = renderReport(store, {});
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("dsh-retro 复盘面板"));
  assert.ok(html.includes("复盘卡片"));
  assert.ok(html.includes("经验条目"));
  assert.ok(html.includes("进化提案"));
  assert.ok(html.includes("发布队列"));
  assert.ok(html.includes("最近审计"));
  // 报告应包含各类状态数据。
  assert.ok(html.includes("复盘 A"));
  assert.ok(html.includes("复盘 B"));
  assert.ok(html.includes("经验 1"));
  assert.ok(html.includes("prop-1"));
  assert.ok(html.includes("post-1"));
  assert.ok(html.includes("rc-1.md"));
  // 统计数量
  assert.ok(html.includes('>2<'));
  // 不应出现对象被直接转为字符串的占位文本。
  assert.ok(!html.includes("[object Object]"));
  rmSync(dir, { recursive: true, force: true });
});

test("renderReport handles an empty store", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-rpt-"));
  const store = new RetroStore(dir);
  const html = renderReport(store, {});
  assert.ok(html.includes("暂无复盘卡片"));
  assert.ok(html.includes("暂无经验条目"));
  assert.ok(html.includes("暂无进化提案"));
  rmSync(dir, { recursive: true, force: true });
});

test("报告转义存储数据中的动态状态", (t) => {
  const { dir, store } = seededStore();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  store.addCard({ title: "状态转义", status: "<img src=x onerror=alert(1)>" });
  const html = renderReport(store);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});
