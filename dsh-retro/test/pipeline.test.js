// dsh-retro: pipeline module tests — collectors / distiller / evolvor / commands pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";

import { buildTranscript, extractEvolutionSuggestions, cleanTitle } from "../lib/distiller.js";
import { attachCollector } from "../lib/collectors.js";
import { RetroStore } from "../lib/store.js";
import { dedupeSuggestions, dedupeProposals, proposeUpdate, adoptProposal, updateMoc, MOC_FILENAME } from "../lib/evolvor.js";
import { ensureDirs, settleEntry, draftEntryFile } from "../lib/settler.js";
import { parseArgs, flags, findTodayWeeklyCard } from "../lib/commands.js";

function tmpEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-pipe-"));
  const vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg = {
    vaultPath: vault,
    blogPath: path.join(dir, "blog"),
    stagingDir: "Index/06_Retro/_retro",
    experienceRoot: "Index/06_Retro/经验库",
    proposalsDir: "Index/06_Retro/_proposals",
    entriesDir: "Index/06_Retro/_entries",
    settleDirs: ["Index/03_Full_Notes/04_Retro", "Index/06_Retro/经验库"],
    readWhitelist: ["Index"],
    autoProposeOnGoalComplete: true
  };
  return { dir, vault, cfg };
}

// ---- distiller: buildTranscript ----
test("buildTranscript extracts user/assistant/tool/goal lines", () => {
  const events = [
    { type: "user/message", data: { message: { content: [{ type: "text", text: "帮我调 bug" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "已定位" }] } } },
    { type: "tool/call", data: { callId: "call_1", name: "read", arguments: { file: "a.js" } } },
    { type: "tool/result", data: { message: { source: { callId: "call_1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "Error: ENOENT" }], isError: true }] }, error: { name: "FsError", code: "ENOENT" } } },
    { type: "goal/change", data: { goal: { objective: "完成 X", phase: "complete" } } },
    { type: "feedback/record", data: { rating: 1 } }
  ];
  const t = buildTranscript(events);
  assert.ok(t.includes("用户: 帮我调 bug"));
  assert.ok(t.includes("助手: 已定位"));
  assert.ok(t.includes("工具调用: read("));
  // 工具名经 callId 配对，错误码与文本都被提取（不再是 [object Object]）
  assert.ok(t.includes("工具失败: read [ENOENT] Error: ENOENT"), t);
  assert.ok(t.includes("目标: 完成 X → complete"));
  assert.ok(t.includes("用户反馈:"));
});

// ---- distiller: extractEvolutionSuggestions ----
test("extractEvolutionSuggestions pulls the evolution section items", () => {
  const md = [
    "## 关键经验",
    "- aaa",
    "",
    "## 进化建议",
    "- 把反复出现的 X 坑写进 retro-writing 技能",
    "- 周报改用中文表格（偏好）",
    "",
    "## 下周重点",
    "- 不算建议"
  ].join("\n");
  const items = extractEvolutionSuggestions(md);
  assert.equal(items.length, 2);
  assert.ok(items[0].includes("X 坑"));
  assert.ok(items[1].includes("表格"));
});

test("extractEvolutionSuggestions handles numbered lists", () => {
  const md = [
    "## 进化建议",
    "",
    "1. 将 curl -4 沉淀为固定排查技能",
    "2、把 6 模块拆解写入工作流模板",
    "3) 工具失败时换用替代工具",
    "",
    "## 下周重点",
    "1. 不算建议"
  ].join("\n");
  const items = extractEvolutionSuggestions(md);
  assert.equal(items.length, 3);
  assert.ok(items[0].includes("curl -4"));
  assert.ok(items[1].includes("6 模块"));
  assert.ok(items[2].includes("替代工具"));
});

test("cleanTitle strips heading marks and decorations", () => {
  assert.equal(cleanTitle("## 项目目标（一句话）"), "项目目标（一句话）");
  assert.equal(cleanTitle("### 复盘"), "复盘");
  assert.equal(cleanTitle("# 标题"), "标题");
  assert.equal(cleanTitle("**加粗** 标题"), "加粗 标题");
});

// ---- collectors ----
function collectorHarness(cfg) {
  const store = new RetroStore(mkdtempSync(path.join(os.tmpdir(), "retro-col-")));
  const handlers = {};
  const ctx = {
    on(type, handler) { handlers[type] = handler; },
    logger: { warn() {} }
  };
  attachCollector(ctx, store, cfg);
  return { store, handlers };
}

function ev(sessionId, type, data) {
  return [{ id: sessionId, header: { cwd: "C:/ws" } }, { type, data }];
}

test("collector proposes on goal-complete once per session", () => {
  const { store, handlers } = collectorHarness({ autoProposeOnGoalComplete: true });
  handlers["session/event"](...ev("s1", "goal/change", { goal: { phase: "complete", objective: "目标" } }));
  handlers["session/event"](...ev("s1", "goal/change", { goal: { phase: "complete", objective: "目标" } })); // duplicate
  const proposals = store.listProposals("pending").filter((p) => p.kind === "retro-suggest");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].sessionId, "s1");
  assert.equal(store.listMaterials().filter((m) => m.kind === "goal-complete").length, 1);
});

test("collector skips goal-complete propose when the session already has a card", () => {
  const { store, handlers } = collectorHarness({ autoProposeOnGoalComplete: true });
  store.addCard({ sessionIds: ["s1"], title: "已有复盘", status: "drafted", source: "test" });
  handlers["session/event"](...ev("s1", "goal/change", { goal: { phase: "complete", objective: "目标" } }));
  assert.equal(store.listProposals("pending").length, 0);
});

test("collector samples feedback, intent, tool-error, and disposal", () => {
  const { store, handlers } = collectorHarness({ autoProposeOnGoalComplete: true });
  handlers["session/event"](...ev("s1", "feedback/record", { rating: 5 }));
  handlers["session/event"](...ev("s1", "user/message", { message: { content: [{ type: "text", text: "我们来复盘一下" }] } }));
  handlers["session/event"](...ev("s1", "tool/result", { ok: false, error: "boom" }));
  handlers["session/event"](...ev("s1", "session/disposed", {}));
  const kinds = store.listMaterials().map((m) => m.kind);
  assert.ok(kinds.includes("feedback"));
  assert.ok(kinds.includes("intent"));
  assert.ok(kinds.includes("tool-error"));
  assert.ok(store.listProposals("pending").some((p) => p.reason === "session-disposed"));
});

test("collector ignores goal-complete when disabled", () => {
  const { store, handlers } = collectorHarness({ autoProposeOnGoalComplete: false });
  handlers["session/event"](...ev("s1", "goal/change", { goal: { phase: "complete" } }));
  assert.equal(store.listProposals("pending").length, 0);
});

test("collector pairs tool errors with real names and codes (no [object Object])", () => {
  const { store, handlers } = collectorHarness({ autoProposeOnGoalComplete: true });
  // 配对：tool/call 记录 callId→name
  handlers["session/event"](...ev("s1", "tool/call", { callId: "call_9", name: "edit" }));
  // 真实形状：data.error 为对象、message 块 isError
  handlers["session/event"](...ev("s1", "tool/result", {
    message: { source: { callId: "call_9" }, content: [{ type: "tool-result", content: [{ type: "text", text: "Error: stale" }], isError: true }] },
    error: { name: "FsError", code: "FS_STALE_VERSION" }
  }));
  const materials = store.listMaterials().filter((m) => m.kind === "tool-error");
  assert.equal(materials.length, 1);
  assert.ok(!materials[0].summary.includes("[object Object]"), materials[0].summary);
  assert.ok(materials[0].summary.includes("edit"), materials[0].summary);
  assert.ok(materials[0].summary.includes("FS_STALE_VERSION"), materials[0].summary);

  // 成功结果不产生素材
  handlers["session/event"](...ev("s1", "tool/result", {
    message: { source: { callId: "call_9" }, content: [{ type: "tool-result", content: [{ type: "text", text: "ok" }], isError: false }] }
  }));
  assert.equal(store.listMaterials().filter((m) => m.kind === "tool-error").length, 1);
});

// ---- evolvor: dedupe ----
test("dedupeSuggestions finds overlapping entries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-dd-"));
  const store = new RetroStore(dir);
  store.addEntry({ title: "ROS2 编译踩坑", status: "approved" });
  store.addEntry({ title: "数据库索引优化", status: "approved" });
  const hits = dedupeSuggestions(store, { title: "ROS2 编译：找不到头文件", takeaways: [] });
  assert.ok(hits.some((h) => h.title.includes("ROS2")));
  assert.ok(!hits.some((h) => h.title.includes("数据库")));
  rmSync(dir, { recursive: true, force: true });
});

// ---- evolvor: proposals ----
test("proposeUpdate writes proposal file; adoptProposal applies with .bak", () => {
  const { dir, vault, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(dir, "dsh-home");

  // seed an existing skill file so .bak is produced
  const skillDir = path.join(dir, "dsh-home", "skills", "retro-writing");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "旧内容");

  const prop = proposeUpdate(cfg, store, { kind: "skill", title: "补一条规则", content: "## 新规则\n- 具体", reason: "反复出现", actor: "test" });
  assert.equal(prop.ok, true);
  assert.ok(prop.relPath.startsWith("_proposals/"));
  // 文件名遵循 日期-时间-主题 命名（不再是内部 id）
  assert.ok(existsSync(path.join(vault, "Index", "06_Retro", prop.relPath)));

  const proposal = store.getProposal(prop.id);
  const adopted = adoptProposal(cfg, store, proposal);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.backedUp, true);
  const final = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  assert.ok(final.includes("## 新规则"));
  assert.equal(store.getProposal(prop.id).status, "adopted");
  process.env.DSH_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});

// ---- evolvor: MOC ----
test("updateMoc builds and refreshes the experience index", () => {
  const { dir, vault, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  const entry = store.addEntry({ title: "第一条经验", status: "drafted", tags: ["x"] });
  draftEntryFile(cfg, store, entry);
  settleEntry(cfg, store, entry);

  const moc = updateMoc(cfg, store, { actor: "test" });
  assert.equal(moc.count, 1);
  const text = readFileSync(path.join(vault, "Index", "06_Retro", "经验库", MOC_FILENAME), "utf8");
  assert.ok(text.includes("第一条经验")); // 链接基于 日期-时间-主题 文件名
  assert.ok(text.includes("entryCount: 1"));

  // second settle → index updates to 2
  const entry2 = store.addEntry({ title: "第二条经验", status: "drafted", tags: [] });
  draftEntryFile(cfg, store, entry2);
  settleEntry(cfg, store, entry2);
  updateMoc(cfg, store, { actor: "test" });
  const text2 = readFileSync(path.join(vault, "Index", "06_Retro", "经验库", MOC_FILENAME), "utf8");
  assert.ok(text2.includes("第二条经验"));
  assert.ok(text2.includes("entryCount: 2"));
  rmSync(dir, { recursive: true, force: true });
});

// ---- evolvor: proposal dedupe (B1) ----
test("dedupeProposals groups semantically-similar pending proposals", () => {
  const proposals = [
    { id: "a", kind: "skill", title: "空会话周报处理规则", reason: "无数据时避免编造", status: "pending" },
    { id: "b", kind: "skill", title: "低会话周报处理规则", reason: "会话少时周报要点", status: "pending" },
    { id: "c", kind: "skill", title: "沙箱拒绝处理流程", reason: "沙箱被拒时行动一致", status: "pending" },
    { id: "d", kind: "agents", title: "exp条目必须关联会话摘要", reason: "经验可追溯", status: "pending" }
  ];
  const groups = dedupeProposals(proposals);
  // a 与 b 相似（同组），c、d 各自独立
  assert.equal(groups.length, 3);
  const abGroup = groups.find((g) => g.representative.id === "a" || g.representative.id === "b");
  assert.ok(abGroup.duplicates.length === 1, "a/b 互为重复且去重后剩代表");
  // 每组代表 + duplicates 的 id 不相交
  const ids = new Set(groups.flatMap((g) => [g.representative.id, ...g.duplicates.map((d) => d.id)]));
  assert.equal(ids.size, 4);
});

test("dedupeProposals ignores non-pending and retro-suggest", () => {
  const proposals = [
    { id: "a", kind: "skill", title: "规则 X", reason: "", status: "adopted" },
    { id: "b", kind: "retro-suggest", title: "建议", reason: "", status: "pending" }
  ];
  const groups = dedupeProposals(proposals);
  assert.equal(groups.length, 0);
});

// ---- commands pure helpers ----
test("parseArgs handles quotes; flags extracts options", () => {
  assert.deepEqual(parseArgs('review rc-1 edit "意见 内容" --dir 03_Full_Notes'), ["review", "rc-1", "edit", "意见 内容", "--dir", "03_Full_Notes"]);
  const f = flags(["draft", "today", "--tags", "a,b", "--push"]);
  assert.deepEqual(f._, ["draft", "today"]);
  assert.equal(f.tags, "a,b");
  assert.equal(f.push, true);
  const f2 = flags(["--blog-auto-push=true"]);
  assert.equal(f2.blogAutoPush, "true");
});

test("findTodayWeeklyCard blocks duplicate same-day weekly cards", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-wk-"));
  const store = new RetroStore(dir);
  assert.equal(findTodayWeeklyCard(store, "2026-08-16"), undefined);
  store.addCard({ sessionIds: [], title: "本周复盘汇总 2026-08-16", source: "weekly", status: "drafted" });
  assert.ok(findTodayWeeklyCard(store, "2026-08-16"));
  // 已处理的周报不再阻挡
  const card = store.listCards()[0];
  store.updateCard(card.id, { status: "approved" });
  assert.equal(findTodayWeeklyCard(store, "2026-08-16"), undefined);
  // 其他来源的卡片不阻挡
  store.addCard({ sessionIds: [], title: "本周复盘汇总 2026-08-16", source: "command", status: "drafted" });
  assert.equal(findTodayWeeklyCard(store, "2026-08-16"), undefined);
  rmSync(dir, { recursive: true, force: true });
});
