// 动作服务层一致性测试：命令与（未来）HTTP 写接口必须复用同一实现，
// 因此这里直接断言服务层产出的文件、状态与审计，而不经由命令文本。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../lib/config.js";
import { ensureDirs, draftCardFiles, writeStaging, stagingRoot } from "../lib/settler.js";
import { createActionService } from "../lib/actions.js";
import { RetroStore } from "../lib/store.js";

function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-actions-"));
  const vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg = { ...DEFAULTS, vaultPath: vault };
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, vault, cfg, store, service: createActionService({ store, cfg }) };
}

test("reviewCard keep 落库并生成经验条目草稿", (t) => {
  const { vault, cfg, store, service } = harness(t);
  const card = store.addCard({ sessionIds: ["s1"], title: "动作服务复盘", source: "test" });
  const { relPath } = draftCardFiles(cfg, store, card, {
    markdown: "## 关键经验\n- 服务层统一写入",
    questions: ["是否沉淀？"]
  });

  const result = service.reviewCard({ id: card.id, subAction: "keep", targetDir: "Index/03_Full_Notes/04_Retro", actor: "web:user" });
  assert.equal(result.status, "approved");
  assert.ok(result.message.includes("已落库"));
  assert.ok(result.message.includes("已生成经验条目草稿"));

  const updated = store.getCard(card.id);
  assert.ok(updated.vaultNote.startsWith("Index/03_Full_Notes/04_Retro/"));
  assert.ok(readFileSync(path.join(vault, updated.vaultNote), "utf8").includes("服务层统一写入"));
  // 暂存文件按 0.5.0 语义原地保留
  assert.ok(existsSync(path.join(stagingRoot(cfg), relPath)));

  const entries = store.listEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cardId, card.id);
  assert.equal(entries[0].status, "drafted");

  const audit = store.listAudit(5);
  assert.ok(audit.some((row) => row.actor === "web:user"), "审计必须记录调用方 actor");
});

test("reviewCard discard 只改状态，不写正式笔记", (t) => {
  const { store, cfg, service } = harness(t);
  const card = store.addCard({ sessionIds: ["s2"], title: "丢弃卡片", source: "test" });
  draftCardFiles(cfg, store, card, { markdown: "x" });
  const result = service.reviewCard({ id: card.id, subAction: "discard", actor: "web:user" });
  assert.equal(result.status, "discarded");
  assert.equal(store.getCard(card.id).vaultNote, null);
});

test("reviewCard 对不存在的卡片抛出明确错误", (t) => {
  const { service } = harness(t);
  assert.throws(() => service.reviewCard({ id: "missing" }), /卡片不存在/);
});

test("keepEntry 沉淀永久笔记并刷新索引", (t) => {
  const { store, service } = harness(t);
  const entry = store.addEntry({ title: "永久经验", use: "复用", model: "m", example: "e", pitfalls: [], links: [], tags: ["experience"], status: "drafted" });
  const result = service.keepEntry({ id: entry.id, actor: "web:user" });
  assert.ok(result.message.includes("已沉淀为永久经验"));
  assert.equal(store.getEntry(entry.id).status, "approved");
  assert.ok(result.path);
});

test("cleanupStaging 只删除已丢弃卡片的暂存文件", (t) => {
  const { cfg, store, service } = harness(t);
  const kept = store.addCard({ sessionIds: ["s3"], title: "保留", source: "test" });
  const { relPath: keptPath } = draftCardFiles(cfg, store, kept, { markdown: "keep" });
  const dropped = store.addCard({ sessionIds: ["s4"], title: "丢弃", source: "test" });
  const { relPath: droppedPath } = draftCardFiles(cfg, store, dropped, { markdown: "drop" });
  store.updateCard(dropped.id, { status: "discarded" });

  const result = service.cleanupStaging({ actor: "web:user" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [droppedPath]);
  assert.ok(existsSync(path.join(stagingRoot(cfg), keptPath)), "未丢弃的暂存文件必须保留");
  assert.ok(!existsSync(path.join(stagingRoot(cfg), droppedPath)));
});

test("cleanupStaging 在未配置知识库时给出明确提示", (t) => {
  const { store } = harness(t);
  const service = createActionService({ store, cfg: { ...DEFAULTS, vaultPath: "" } });
  const result = service.cleanupStaging();
  assert.equal(result.ok, false);
  assert.match(result.message, /vaultPath/);
});

test("adopt 单个提案写入目标文件并记录审计", (t) => {
  const { store, cfg, service } = harness(t);
  // 目标文件放在 DSH_HOME 之外的临时目录，避免污染真实用户目录
  const previousHome = process.env.DSH_HOME;
  const home = path.join(path.dirname(cfg.vaultPath), "dsh-home");
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  mkdirSync(path.join(home, "skills", "retro-writing"), { recursive: true });
  writeFileSync(path.join(home, "skills", "retro-writing", "SKILL.md"), "---\nname: retro-writing\ndescription: 测试\n---\n\n# 已有正文\n", "utf8");

  const proposal = store.addProposal({ kind: "skill", title: "新增规则", reason: "测试" });
  writeStaging(cfg, `_proposals/${proposal.id}.md`, `.dsh-retro-proposal\n\n## 新增规则\n- 规则内容\n`, { store });
  store.updateProposal(proposal.id, { relPath: `_proposals/${proposal.id}.md` });

  const result = service.adopt({ target: proposal.id, actor: "web:user" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.adopted, [proposal.id]);
  assert.equal(store.getProposal(proposal.id).status, "adopted");
  assert.ok(store.listAudit(5).some((row) => row.action === "adopt"));
});
