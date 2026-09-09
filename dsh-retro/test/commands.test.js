// 通过注册后的命令处理器验证首次配置与 DSH 标题接口，不启动真实会话。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { registerCommands, openReport } from "../lib/commands.js";
import { DEFAULTS } from "../lib/config.js";
import { RetroStore } from "../lib/store.js";

function harness(t, overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-commands-"));
  const previous = process.env.DSH_RETRO_DIR;
  process.env.DSH_RETRO_DIR = path.join(dir, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_RETRO_DIR;
    else process.env.DSH_RETRO_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const cfg = structuredClone(DEFAULTS);
  const store = new RetroStore(process.env.DSH_RETRO_DIR);
  const commands = new Map();
  registerCommands({ commands: { register(def) { commands.set(def.name, def.handler); } }, ...overrides }, store, cfg);
  return { dir, cfg, store, run: (name, rawInput) => commands.get(name)({ rawInput }) };
}

test("运行时修改路径后，同一实例下一条命令立即读取新配置", async (t) => {
  const { dir, cfg, run } = harness(t);
  const vault = path.join(dir, "新的知识库");
  assert.equal((await run("retro", `config vaultPath "${vault}"`)).kind, "success");
  assert.equal(cfg.vaultPath, vault);
  assert.match((await run("retro", "config vaultPath")).text, /新的知识库/);
  const saved = JSON.parse(readFileSync(path.join(dir, "state", "config.json"), "utf8"));
  assert.equal(saved.vaultPath, vault);
});

test("配置命令将单项与多项目录列表都解析为数组", async (t) => {
  const { cfg, run } = harness(t);
  assert.equal((await run("retro", "config readWhitelist Index")).kind, "success");
  assert.deepEqual(cfg.readWhitelist, ["Index"]);
  assert.equal((await run("retro", "config settleDirs Index/Notes,Index/Projects")).kind, "success");
  assert.deepEqual(cfg.settleDirs, ["Index/Notes", "Index/Projects"]);
});

test("配置命令拒绝无效类型、空目录列表、分段死循环参数和未知键", async (t) => {
  const { cfg, run } = harness(t);
  for (const input of ["config weeklyReminderDays zero", "config chunkChars 0", "config chunkChars -1", "config settleDirs ,", "config blogAutoPush yes", "config unknown value"]) {
    assert.equal((await run("retro", input)).kind, "error", input);
  }
  assert.equal(cfg.chunkChars, DEFAULTS.chunkChars);
  assert.equal(cfg.blogAutoPush, false);
});

test("周报使用 DSH readTitle 返回的 title 字段", async (t) => {
  const prompts = [];
  const { cfg, dir, run } = harness(t, {
    sessionQuery: {
      async listSessions() { return [{ header: { id: "s1", createdAt: new Date().toISOString() } }]; },
      async readSession() { return { events: [{ type: "user/message", data: { message: { content: "完成了插件标准化" } } }] }; },
      async readTitle() { return { title: "插件标准化会话", source: "user" }; }
    },
    llm: {
      async *stream(request) {
        prompts.push(request.messages[0].content[0].text);
        yield { type: "text-delta", index: 0, text: "# 本周复盘\n\n## 本周三件事\n- 完成插件标准化" };
      }
    }
  });
  cfg.vaultPath = path.join(dir, "vault");
  assert.equal((await run("weekly", "")).kind, "success");
  assert.ok(prompts.some((prompt) => prompt.includes("插件标准化会话")));
  assert.ok(prompts.every((prompt) => !prompt.includes("[object Object]")));
});

test("报告按平台选择打开器，并将特殊文件名作为独立 URL 参数传递", async () => {
  const file = path.resolve("报告 & 引号' 空格.html");
  const url = pathToFileURL(file).href;
  for (const [platform, command, args] of [
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", url]],
    ["darwin", "open", [url]],
    ["linux", "xdg-open", [url]]
  ]) {
    let released = false;
    const result = await openReport(file, {
      platform,
      spawnProcess(actualCommand, actualArgs, options) {
        assert.equal(actualCommand, command);
        assert.deepEqual(actualArgs, args);
        assert.equal(options.shell, undefined);
        assert.equal(options.windowsHide, true);
        const child = new EventEmitter();
        child.unref = () => { released = true; };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(released, true);
  }
});

test("报告打开器的异步启动失败返回原因，不产生未处理异常", async () => {
  const result = await openReport("report.html", {
    spawnProcess() {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("ENOENT: 找不到打开器")));
      return child;
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});
