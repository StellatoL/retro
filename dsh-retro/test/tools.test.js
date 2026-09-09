// 使用官方 defineTool 和 JSON Schema 校验器验证模型工具契约，不调用真实模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { registerTools } from "../lib/tools.js";
import { RetroStore } from "../lib/store.js";
import { DEFAULTS } from "../lib/config.js";

function harness(t, overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RetroStore(path.join(dir, "state"));
  const definitions = new Map();
  const ctx = { tools: { register(tool) { definitions.set(tool.name, tool); } }, ...overrides };
  registerTools(ctx, store, { ...DEFAULTS, vaultPath: path.join(dir, "vault") });
  return { store, definitions };
}

test("素材工具返回符合官方契约的 JSON 值和文本块", async (t) => {
  const { store, definitions } = harness(t);
  const tool = definitions.get("retro_capture");
  const args = { summary: "保留一次接口兼容修复", importance: 2 };
  const result = await tool.execute(args, { agent: { session: { id: "s1" } } });
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
  const content = tool.output.render(args, result);
  assert.ok(Array.isArray(content), "DSH output.render 必须返回 ContentBlock[]");
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /已捕获素材/);
  assert.equal(store.listMaterials()[0].sessionId, "s1");
});

test("草稿工具缺失会话时的返回值符合输出 schema", async (t) => {
  const { definitions } = harness(t);
  const tool = definitions.get("retro_draft");
  const result = await tool.execute({}, {});
  assert.equal(result.ok, false);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
  assert.equal(tool.output.render({}, result)[0].type, "text");
});

test("已有卡片没有暂存文件时仍返回合法结果，且不重复调用模型", async (t) => {
  const { definitions, store } = harness(t, { sessionQuery: {} });
  store.addCard({ sessionIds: ["s1"], title: "已有草稿" });
  const tool = definitions.get("retro_draft");
  const result = await tool.execute({ sessionId: "s1" }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
  assert.equal(store.listCards().length, 1);
});

test("素材工具拒绝超出 0 到 3 范围的重要性", async (t) => {
  const { definitions, store } = harness(t);
  await assert.rejects(definitions.get("retro_capture").execute({ summary: "无效输入", importance: 4 }, {}));
  assert.equal(store.listMaterials().length, 0);
});

test("已经取消的工具调用不再写入素材", async (t) => {
  const { definitions, store } = harness(t);
  const signal = AbortSignal.abort(new Error("用户取消"));
  await assert.rejects(definitions.get("retro_capture").execute({ summary: "不应保存" }, { signal }), /用户取消/);
  assert.equal(store.listMaterials().length, 0);
});

test("提炼过程传递调用者取消信号，取消后不写卡片", async (t) => {
  const controller = new AbortController();
  let receivedSignal;
  const { definitions, store } = harness(t, {
    sessionQuery: { async readSession() { return { events: [{ type: "user/message", data: { message: { content: "复盘这次改动" } } }] }; } },
    llm: {
      async *stream(request) {
        receivedSignal = request.signal;
        controller.abort(new Error("用户取消提炼"));
        yield { type: "text-delta", index: 0, text: "# 不应保存的卡片" };
      }
    }
  });
  await assert.rejects(definitions.get("retro_draft").execute({ sessionId: "s1" }, { signal: controller.signal }), /用户取消提炼/);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(store.listCards().length, 0);
});
