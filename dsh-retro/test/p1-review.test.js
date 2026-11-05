// P1 审阅闭环后端测试：提案预览、批量采纳、卡片内联写回与乐观锁。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../lib/config.js";
import { ensureDirs, draftCardFiles, readStaging, writeStaging } from "../lib/settler.js";
import { RetroStore } from "../lib/store.js";
import { computeContentHash } from "../lib/guard.js";
import { createQueryService } from "../lib/query.js";
import { registerActionApi } from "../lib/api.js";

function harness(t, { enableWriteApi = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-p1-"));
  const vault = path.join(dir, "vault");
  const home = path.join(dir, "dsh-home");
  mkdirSync(vault, { recursive: true });
  mkdirSync(path.join(home, "skills", "retro-writing"), { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const cfg = { ...DEFAULTS, vaultPath: vault, security: { ...DEFAULTS.security, enableWriteApi } };
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, vault, home, cfg, store, query: createQueryService({ store, cfg }) };
}

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

function jsonRequest(payload) {
  const req = new EventEmitter();
  req.method = "POST";
  req.destroy = () => {};
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
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

function seedProposal(cfg, store, { id, title, reason, content, kind = "skill" }) {
  const relPath = `_proposals/${id}.md`;
  writeStaging(cfg, relPath, `---\nType: dsh_retro_proposal\nkind: ${kind}\n---\n\n# ${title}\n\n\`\`\`markdown\n${content}\n\`\`\`\n`, { store, actor: "test" });
  return store.addProposal({ id, kind, title, reason, status: "pending", relPath });
}

test("提案详情返回追加片段、目标文件状态与重复提示", (t) => {
  const { cfg, home, store, query } = harness(t);
  writeFileSync(path.join(home, "skills", "retro-writing", "SKILL.md"), "---\nname: retro-writing\ndescription: x\n---\n\n# 既有正文\n", "utf8");
  seedProposal(cfg, store, { id: "p1", title: "空会话周报处理规则", reason: "无数据时不要编造", content: "## 空会话周报\n- 直接说明无数据" });
  seedProposal(cfg, store, { id: "p2", title: "空会话周报处理规则", reason: "无数据时不要编造内容", content: "## 空会话周报\n- 直接说明无数据" });

  const detail = query.getEntityDetail({ type: "proposal", id: "p1" });
  assert.equal(detail.meta.targetExists, true);
  assert.ok(detail.meta.targetFile.endsWith("SKILL.md"));
  assert.deepEqual(detail.preview.appendedLines.slice(0, 2), ["## 空会话周报", "- 直接说明无数据"]);
  assert.equal(detail.preview.changedLines, 2);
  assert.ok(detail.preview.existingTail.some((line) => line.includes("既有正文")), "应给出目标文件末尾上下文");
  assert.ok(detail.meta.duplicateOf, "相似提案应给出重复提示");
  assert.equal(detail.meta.duplicateOf.id, "p2");
});

test("批量采纳指定提案：全部落库并记录 web:user 审计", async (t) => {
  const { cfg, home, store, dir } = harness(t);
  writeFileSync(path.join(home, "skills", "retro-writing", "SKILL.md"), "---\nname: retro-writing\ndescription: x\n---\n\n# 已有\n", "utf8");
  seedProposal(cfg, store, { id: "p1", title: "规则 A", reason: "原因 A", content: "## 规则 A\n- A" });
  seedProposal(cfg, store, { id: "p2", title: "规则 B", reason: "原因 B", content: "## 规则 B\n- B" });
  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });

  const res = captureResponse();
  await holder.route.handler(jsonRequest({ action: "proposal.adopt", ids: ["p1", "p2"] }), res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.deepEqual(payload.result.adopted, ["p1", "p2"]);
  const skill = readFileSync(path.join(home, "skills", "retro-writing", "SKILL.md"), "utf8");
  assert.ok(skill.includes("## 规则 A") && skill.includes("## 规则 B"));
  assert.ok(store.listAudit(10).some((row) => row.actor === "web:user" && row.action === "adopt"));
});

test("all 采纳先按相似度去重，重复项标记 skipped", async (t) => {
  const { cfg, home, store, dir } = harness(t);
  writeFileSync(path.join(home, "agents.md"), "", "utf8");
  seedProposal(cfg, store, { id: "p1", kind: "agents", title: "先读后写", reason: "减少失败", content: "## 先读后写\n- 规则" });
  seedProposal(cfg, store, { id: "p2", kind: "agents", title: "先读后写", reason: "减少失败率", content: "## 先读后写\n- 规则" });
  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });
  const res = captureResponse();
  await holder.route.handler(jsonRequest({ action: "proposal.adopt", all: true }), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.result.adopted, ["p1"]);
  assert.deepEqual(payload.result.skipped, ["p2"]);
  assert.equal(store.getProposal("p2").status, "skipped");
});

test("card.patch 局部写回暂存文件并返回新哈希", async (t) => {
  const { cfg, store, dir } = harness(t);
  const card = store.addCard({ title: "内联编辑", source: "test" });
  const { relPath } = draftCardFiles(cfg, store, card, {
    markdown: "## 行动项\n\n- [ ] 旧行动\n\n## 附注图表\n\n用户手写内容\n",
    questions: []
  });
  const before = readStaging(cfg, relPath);
  const beforeHash = computeContentHash(before);

  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });
  const res = captureResponse();
  await holder.route.handler(jsonRequest({
    action: "card.patch",
    id: card.id,
    expectedHash: beforeHash,
    sections: { actions: "- [x] 新行动" },
    answers: [{ question: "是否沉淀？", answer: "是" }]
  }), res);

  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.notEqual(payload.result.contentHash, beforeHash);
  const after = readStaging(cfg, relPath);
  assert.ok(after.includes("- [x] 新行动"));
  assert.ok(after.includes("用户手写内容"), "用户手写章节必须保留");
  assert.ok(after.includes("是否沉淀？"));
  assert.equal(store.getCard(card.id).contentHash, payload.result.contentHash);
});

test("card.patch 使用过期哈希时返回 409 且不写入", async (t) => {
  const { cfg, store, dir } = harness(t);
  const card = store.addCard({ title: "冲突", source: "test" });
  const { relPath } = draftCardFiles(cfg, store, card, { markdown: "## 行动项\n\n- 原样\n", questions: [] });
  const original = readStaging(cfg, relPath);

  const { ctx, holder } = captureRoute();
  registerActionApi(ctx, store, cfg, { lockDir: dir });
  const res = captureResponse();
  await holder.route.handler(jsonRequest({
    action: "card.patch",
    id: card.id,
    expectedHash: "0000000000000000",
    sections: { actions: "- 覆盖" }
  }), res);
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).error.code, "RETRO_CONFLICT_HASH");
  assert.equal(readStaging(cfg, relPath), original);
});
