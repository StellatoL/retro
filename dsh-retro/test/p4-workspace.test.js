// 多工作区测试：配置解析、命令管理与受控切换接口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCommands } from "../lib/commands.js";
import { DEFAULTS, listWorkspaces, loadConfig, saveConfig } from "../lib/config.js";
import { RetroStore } from "../lib/store.js";
import { createQueryService } from "../lib/query.js";
import { registerActionApi } from "../lib/api.js";

/** 统一临时环境：配置写在 DSH_RETRO_DIR 下，读取走 loadConfig。 */
function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-workspace-"));
  const previous = process.env.DSH_RETRO_DIR;
  process.env.DSH_RETRO_DIR = path.join(dir, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_RETRO_DIR;
    else process.env.DSH_RETRO_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, loadConfig(cfg));
  const store = new RetroStore(process.env.DSH_RETRO_DIR);
  const commands = new Map();
  registerCommands({ commands: { register(def) { commands.set(def.name, def.handler); } } }, store, cfg);
  return {
    dir,
    cfg,
    store,
    run: (name, rawInput) => commands.get(name)({ rawInput })
  };
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

/** 配置读写一律指向临时目录，绝不触碰真实 ~/.dsh/retro/config.json。 */
function tempConfigHome(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-workspace-home-"));
  const previous = process.env.DSH_RETRO_DIR;
  process.env.DSH_RETRO_DIR = path.join(dir, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_RETRO_DIR;
    else process.env.DSH_RETRO_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("未配置工作区时配置解析保持单库语义", (t) => {
  tempConfigHome(t);
  saveConfig({ vaultPath: "/vaults/single", workspaces: [], activeWorkspace: "" });
  const cfg = loadConfig({});
  assert.equal(cfg.vaultPath, "/vaults/single");
  assert.deepEqual(listWorkspaces(cfg), []);
});

test("激活工作区时按工作区覆盖 vaultPath 与 blogPath", (t) => {
  tempConfigHome(t);
  saveConfig({
    vaultPath: "/vaults/fallback",
    blogPath: "/blogs/fallback",
    workspaces: [
      { id: "main", name: "主库", vaultPath: "/vaults/main", blogPath: "/blogs/main" },
      { id: "team", name: "团队库", vaultPath: "/vaults/team" }
    ],
    activeWorkspace: "team"
  });
  const cfg = loadConfig({});
  assert.equal(cfg.vaultPath, "/vaults/team");
  assert.equal(cfg.blogPath, "/blogs/fallback", "工作区未声明 blogPath 时保留原值");
  const listed = listWorkspaces(cfg);
  assert.equal(listed.length, 2);
  assert.equal(listed.find((item) => item.active).id, "team");

  saveConfig({ activeWorkspace: "main" });
  const switched = loadConfig({});
  assert.equal(switched.vaultPath, "/vaults/main");
  assert.equal(switched.blogPath, "/blogs/main", "工作区声明了 blogPath 时一并覆盖");
});

test("/retro workspace add/use/remove 管理当前工作区", async (t) => {
  const { dir, cfg, run } = harness(t);
  const vaultA = path.join(dir, "vault-a");
  const vaultB = path.join(dir, "vault-b");

  const empty = await run("retro", "workspace list");
  assert.equal(empty.kind, "success");
  assert.match(empty.text, /未配置工作区/);

  assert.equal((await run("retro", `workspace add a A库 "${vaultA}"`)).kind, "success");
  assert.equal(cfg.activeWorkspace, "a", "首个工作区应自动设为当前");
  assert.equal(cfg.vaultPath, vaultA);

  assert.equal((await run("retro", `workspace add b B库 "${vaultB}"`)).kind, "success");
  assert.equal((await run("retro", "workspace use b")).kind, "success");
  assert.equal(cfg.vaultPath, vaultB);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "state", "config.json"), "utf8")).activeWorkspace, "b");

  const listed = await run("retro", "workspace list");
  assert.match(listed.text, /b/);

  assert.equal((await run("retro", `workspace remove ${"b"}`)).kind, "success");
  assert.equal(cfg.activeWorkspace, "", "移除当前工作区后回到单库配置");
  assert.equal(listWorkspaces(cfg).length, 1);

  const unknown = await run("retro", "workspace use nope");
  assert.equal(unknown.kind, "error");
});

test("工作区列表出现在快照中且不影响 stats 形态", (t) => {
  const home = tempConfigHome(t);
  saveConfig({ workspaces: [{ id: "a", name: "A", vaultPath: "/va" }], activeWorkspace: "a" });
  const store = new RetroStore(path.join(home, "state"));
  const cfg = loadConfig({});
  const snapshot = createQueryService({ store, cfg }).getSnapshot();
  assert.equal(snapshot.activeWorkspace, "a");
  assert.equal(snapshot.workspaces.length, 1);
  assert.ok(snapshot.stats && typeof snapshot.stats.cards === "number");
});

test("workspace.switch 受写接口开关约束，开启后生效", async (t) => {
  const { dir } = harness(t);
  const vaultA = path.join(dir, "vault-a");
  const vaultB = path.join(dir, "vault-b");
  saveConfig({ workspaces: [{ id: "a", name: "A", vaultPath: vaultA }, { id: "b", name: "B", vaultPath: vaultB }], activeWorkspace: "a" });

  // 关闭写接口：拒绝切换
  const closedCfg = { ...loadConfig({}), security: { ...DEFAULTS.security, enableWriteApi: false } };
  const store = new RetroStore(process.env.DSH_RETRO_DIR);
  const closed = captureRoute();
  registerActionApi(closed.ctx, store, closedCfg, { lockDir: dir });
  const rejected = captureResponse();
  await closed.holder.route.handler(jsonRequest({ action: "workspace.switch", id: "b" }), rejected);
  assert.equal(rejected.status, 403);
  assert.equal(JSON.parse(rejected.body).error.code, "RETRO_WRITE_DISABLED");

  // 开启写接口：切换成功并落盘
  const openCfg = { ...loadConfig({}), security: { ...DEFAULTS.security, enableWriteApi: true } };
  const open = captureRoute();
  registerActionApi(open.ctx, store, openCfg, { lockDir: dir });
  const accepted = captureResponse();
  await open.holder.route.handler(jsonRequest({ action: "workspace.switch", id: "b" }), accepted);
  assert.equal(accepted.status, 200);
  const payload = JSON.parse(accepted.body);
  assert.equal(payload.result.activeWorkspace, "b");
  assert.equal(payload.result.vaultPath, vaultB);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "state", "config.json"), "utf8")).activeWorkspace, "b");

  // 不存在的工作区返回 404
  const missing = captureResponse();
  await open.holder.route.handler(jsonRequest({ action: "workspace.switch", id: "zzz" }), missing);
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error.code, "RETRO_ENTITY_NOT_FOUND");
});
