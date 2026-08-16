// dsh-retro smoke tests: pure modules only (no dsh runtime needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";

import {
  safeJoin, slugify, nowStamp, textOf, parseFrontmatter, renderFrontmatter,
  renderTemplater, clip, loadTemplate, fallbackTemplate, atomicWrite, readOptional
} from "../lib/util.js";
import { RetroStore } from "../lib/store.js";
import { loadConfig, saveConfig, retroDir, configPath } from "../lib/config.js";
import {
  ensureDirs, writeStaging, readStaging, renderCardTemplate, draftCardFiles, settleCard, draftEntryFile, settleEntry, splitCardFile,
  stripQuestionsSection, mergeIntoTemplate
} from "../lib/settler.js";

function tmpVault() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-test-"));
  const vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  return { dir, vault };
}

function testCfg(vault) {
  return {
    vaultPath: vault,
    blogPath: path.join(path.dirname(vault), "blog"),
    stagingDir: "Index/06_Retro/_retro",
    experienceRoot: "Index/06_Retro/经验库",
    proposalsDir: "Index/06_Retro/_proposals",
    entriesDir: "Index/06_Retro/_entries",
    settleDirs: ["03_Full_Notes", "04_Projects", "Index/06_Retro/经验库"],
    readWhitelist: ["00_Inbox", "03_Full_Notes", "04_Projects", "05_Weekly_review", "06_Retro"],
    templates: {},
    autoProposeOnGoalComplete: true,
    weeklyReminderDays: 7,
    blogAutoPush: false
  };
}

// ---- util ----
test("safeJoin rejects traversal", () => {
  const root = "C:/vault";
  assert.throws(() => safeJoin(root, "../evil.md"));
  assert.throws(() => safeJoin(root, "a/../../evil.md"));
  assert.throws(() => safeJoin(root, ".obsidian/config"));
  assert.throws(() => safeJoin(root, "a/.git/config"));
  assert.equal(safeJoin(root, "00_Inbox/_retro/x.md"), path.resolve(root, "00_Inbox/_retro/x.md"));
});

test("slugify keeps CJK and lowercases latin", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  assert.ok(slugify("踩坑记录：ROS2 编译").includes("ros2"));
  assert.equal(slugify("   "), "untitled");
});

test("frontmatter roundtrip", () => {
  const text = "---\ntitle: \"hello: world\"\npublished: 2025-01-01\ndraft: false\ntags:\n  - a\n  - \"b c\"\n---\n\nbody";
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.title, "hello: world");
  assert.equal(data.draft, false);
  assert.deepEqual(data.tags, ["a", "b c"]);
  assert.equal(body.trim(), "body");
  const rendered = renderFrontmatter([["title", "hello: world"], ["tags", ["a", "b c"]], ["draft", false]]);
  const { data: again } = parseFrontmatter(rendered + "\n\nbody");
  assert.equal(again.title, "hello: world");
  assert.deepEqual(again.tags, ["a", "b c"]);
});

test("renderTemplater materializes common expressions", () => {
  const t = "date: <% tp.file.creation_date(\"YYYY-MM-DD HH:mm\") %>\ntitle: <% tp.file.title %>\nkeep: <% tp.file.last_modified_date(\"YYYY-MM-DD\") %>";
  const { text, warnings } = renderTemplater(t, { createDate: "2026-01-01 10:00", modifyDate: "2026-01-02", title: "复盘" });
  assert.equal(text, "date: 2026-01-01 10:00\ntitle: 复盘\nkeep: 2026-01-02");
  assert.equal(warnings.length, 0);
  const unknown = renderTemplater("x <% tp.file.weird() %> y");
  assert.equal(unknown.warnings.length, 1);
});

test("textOf handles string and block content", () => {
  assert.equal(textOf({ content: "hi" }), "hi");
  assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(textOf({ content: [{ type: "tool-result", content: "done" }] }), "done");
});

// ---- store ----
test("RetroStore roundtrip and audit", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-store-"));
  const store = new RetroStore(dir);
  const m = store.addMaterial({ sessionId: "s1", kind: "test", summary: "x", importance: 2 });
  assert.ok(m.id.startsWith("mat-"));
  const card = store.addCard({ sessionIds: ["s1"], title: "T", source: "test" });
  assert.ok(card.id.startsWith("rc-"));
  store.updateCard(card.id, { status: "approved" });
  store.audit({ actor: "test", action: "x", target: "y" });
  const store2 = new RetroStore(dir);
  assert.equal(store2.getCard(card.id).status, "approved");
  assert.equal(store2.listMaterials()[0].summary, "x");
  assert.equal(store2.listAudit()[0].action, "x");
  rmSync(dir, { recursive: true, force: true });
});

// ---- settler ----
test("staging write whitelist", () => {
  const { dir, vault } = tmpVault();
  const cfg = testCfg(vault);
  ensureDirs(cfg);
  const target = writeStaging(cfg, "draft-1.md", "# hello");
  assert.ok(readFileSync(target, "utf8").includes("hello"));
  assert.throws(() => writeStaging(cfg, "../escape.md", "x"));
  assert.throws(() => writeStaging(cfg, ".obsidian/x.md", "x"));
  rmSync(dir, { recursive: true, force: true });
});

test("owned-dir routing: _entries and _proposals land in their own roots", () => {
  const { dir, vault } = tmpVault();
  const cfg = testCfg(vault);
  ensureDirs(cfg);
  const card = writeStaging(cfg, "rc-x.md", "card");
  const entry = writeStaging(cfg, "_entries/e1.md", "entry");
  const proposal = writeStaging(cfg, "_proposals/p1.md", "proposal");
  assert.ok(card.startsWith(path.join(vault, "Index", "06_Retro", "_retro")));
  assert.ok(entry.startsWith(path.join(vault, "Index", "06_Retro", "_entries")));
  assert.ok(proposal.startsWith(path.join(vault, "Index", "06_Retro", "_proposals")));
  assert.equal(readStaging(cfg, "_entries/e1.md"), "entry");
  assert.equal(readStaging(cfg, "_proposals/p1.md"), "proposal");
  assert.throws(() => writeStaging(cfg, "_entries/../evil.md", "x"));
  rmSync(dir, { recursive: true, force: true });
});

test("draft card file + settle keep + discard", () => {
  const { dir, vault } = tmpVault();
  const cfg = testCfg(vault);
  const store = new RetroStore(path.join(dir, "store"));
  ensureDirs(cfg);
  const card = store.addCard({ sessionIds: ["s1"], title: "测试复盘", source: "test" });
  const { relPath } = draftCardFiles(cfg, store, card, {
    markdown: "## 关键经验\n- 用 X 代替 Y",
    questions: ["是否值得沉淀？"]
  });
  assert.ok(relPath.endsWith(".md"));
  const staged = readStaging(cfg, relPath);
  assert.ok(staged.includes("待确认问题"));
  assert.ok(staged.includes("用 X 代替 Y"));

  const { title, body } = splitCardFile(staged);
  assert.equal(title, null); // no # heading in this draft body

  const settled = settleCard(cfg, store, card, { action: "keep", dir: "03_Full_Notes" });
  assert.equal(settled.status, "approved");
  assert.ok(card.vaultNote.startsWith("03_Full_Notes/"));
  assert.ok(readFileSync(path.join(vault, card.vaultNote), "utf8").includes("用 X 代替 Y"));

  const card2 = store.addCard({ sessionIds: ["s2"], title: "丢弃", source: "test" });
  draftCardFiles(cfg, store, card2, { markdown: "x" });
  settleCard(cfg, store, card2, { action: "discard" });
  assert.equal(store.getCard(card2.id).status, "discarded");
  rmSync(dir, { recursive: true, force: true });
});

test("settle refuses unknown dir", () => {
  const { dir, vault } = tmpVault();
  const cfg = testCfg(vault);
  const store = new RetroStore(path.join(dir, "store"));
  ensureDirs(cfg);
  const card = store.addCard({ sessionIds: ["s1"], title: "t", source: "test" });
  draftCardFiles(cfg, store, card, { markdown: "x" });
  assert.throws(() => settleCard(cfg, store, card, { action: "keep", dir: "01_Personal" }));
  rmSync(dir, { recursive: true, force: true });
});

test("entry draft + settle into experience root", () => {
  const { dir, vault } = tmpVault();
  const cfg = testCfg(vault);
  const store = new RetroStore(path.join(dir, "store"));
  ensureDirs(cfg);
  const entry = store.addEntry({ title: "原子经验A", use: "条件", model: "原理", example: "例子", pitfalls: ["坑1"], links: [], source: "card", status: "drafted" });
  const { relPath } = draftEntryFile(cfg, store, entry);
  assert.ok(relPath.startsWith("_entries/"));
  const settled = settleEntry(cfg, store, entry);
  assert.ok(settled.path.includes("经验库"));
  assert.ok(readFileSync(path.join(vault, settled.path), "utf8").includes("原子经验A"));
  rmSync(dir, { recursive: true, force: true });
});

test("template fallback renders without Templater leftovers", () => {
  const { dir, vault } = tmpVault();
  const cfg = testCfg(vault);
  const text = renderCardTemplate(cfg, "experience", { title: "复盘", createDate: nowStamp(), modifyDate: nowStamp(), _warnings: [] });
  assert.ok(!text.includes("<%"));
  assert.ok(text.includes("## 项目目标"));
  rmSync(dir, { recursive: true, force: true });
});

test("mergeIntoTemplate sanitizes a corrupted title (## leak)", () => {
  const template = [
    "---",
    "Type: project_experience",
    "---",
    "",
    "# {{title}}",
    "",
    "## 项目目标",
    ""
  ].join("\n");
  const merged = mergeIntoTemplate(template, "## 项目目标（一句话）", "## 项目目标\n实现 X");
  // The H1 must be clean (no "##" inside it), and the section heading intact.
  const h1 = /^# (.+)$/m.exec(merged)[1];
  assert.ok(!h1.includes("##"));
  assert.equal(h1, "项目目标（一句话）");
  assert.ok(merged.includes("## 项目目标"));
  assert.ok(merged.includes("实现 X"));
  assert.ok(!merged.includes("# ##"));
});

test("stripQuestionsSection removes review footer", () => {
  const body = "## 关键经验\n- a\n\n---\n\n## 待确认问题\n1. 是否保留？";
  assert.ok(!stripQuestionsSection(body).includes("待确认问题"));
  assert.ok(stripQuestionsSection(body).includes("关键经验"));
  const plain = "## 只有正文";
  assert.equal(stripQuestionsSection(plain), "## 只有正文");
});

test("mergeIntoTemplate fills template sections and appends extras", () => {
  const template = [
    "---",
    "Type: project_experience",
    "---",
    "",
    "# {{title}}",
    "",
    "## 项目目标",
    "",
    "## 踩坑与根因",
    "",
    "## 行动项",
    ""
  ].join("\n");
  const cardBody = [
    "## 项目目标",
    "实现 X",
    "",
    "## 踩坑与根因",
    "- 现象 A",
    "",
    "## 额外小节",
    "内容 B"
  ].join("\n");
  const merged = mergeIntoTemplate(template, "复盘标题", cardBody);
  assert.ok(merged.includes("# 复盘标题"));
  assert.ok(merged.includes("实现 X"));
  assert.ok(merged.includes("- 现象 A"));
  assert.ok(merged.includes("## 额外小节"));
  assert.ok(merged.includes("内容 B"));
  assert.ok(!merged.includes("{{title}}"));
  // template's empty 行动项 stays
  assert.ok(merged.includes("## 行动项"));
});

// ---- config ----
test("config precedence: defaults < file overrides", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-cfg-"));
  process.env.DSH_RETRO_DIR = dir;
  const cfg = loadConfig({ vaultPath: "C:/row" });
  assert.equal(cfg.vaultPath, "C:/row");
  saveConfig({ vaultPath: "C:/file", blogAutoPush: true });
  const cfg2 = loadConfig({ vaultPath: "C:/row" });
  assert.equal(cfg2.vaultPath, "C:/file");
  assert.equal(cfg2.blogAutoPush, true);
  assert.equal(cfg2.llmProvider, "deepseek-official"); // default preserved
  delete process.env.DSH_RETRO_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("config is privacy-neutral: empty defaults, env vars drive paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-cfg-"));
  process.env.DSH_RETRO_DIR = dir;
  delete process.env.DSH_RETRO_VAULT;
  delete process.env.DSH_RETRO_BLOG;
  const cfg = loadConfig({});
  assert.equal(cfg.vaultPath, ""); // no personal paths baked into the repo
  assert.equal(cfg.blogPath, "");
  process.env.DSH_RETRO_VAULT = "C:/env-vault";
  process.env.DSH_RETRO_BLOG = "C:/env-blog";
  process.env.DSH_RETRO_BLOG_URL = "https://example.com";
  const cfg2 = loadConfig({});
  assert.equal(cfg2.vaultPath, "C:/env-vault");
  assert.equal(cfg2.blogPath, "C:/env-blog");
  assert.equal(cfg2.blogBaseUrl, "https://example.com");
  delete process.env.DSH_RETRO_DIR;
  delete process.env.DSH_RETRO_VAULT;
  delete process.env.DSH_RETRO_BLOG;
  delete process.env.DSH_RETRO_BLOG_URL;
  rmSync(dir, { recursive: true, force: true });
});

test("writeStaging refuses to run without vaultPath", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-cfg-"));
  const cfg = { vaultPath: "", stagingDir: "x" };
  assert.throws(() => writeStaging(cfg, "a.md", "x"), /vaultPath 未配置/);
  assert.throws(() => readStaging(cfg, "a.md"), /vaultPath 未配置/);
  rmSync(dir, { recursive: true, force: true });
});
