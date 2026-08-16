// Integration smoke: exercise apply() with a stub ctx (no real dsh runtime).
// Verifies: module wiring, command/tool registration, collector attach,
// and that boot writes stay inside the (temp) vault paths.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "retro-ctx-"));
process.env.DSH_RETRO_DIR = path.join(tmp, "retro-state");
process.env.DSH_HOME = path.join(tmp, "dsh-home"); // keep ensureSkillFiles from touching the real ~/.dsh

const registered = { commands: [], tools: [], listeners: [], routes: [] };
const ctx = {
  config: { vaultPath: path.join(tmp, "vault"), blogPath: path.join(tmp, "blog"), stagingDir: "Index/06_Retro/_retro" },
  logger: { info: (...a) => console.log("INFO", ...a), warn: (...a) => console.log("WARN", ...a), error: (...a) => console.log("ERROR", ...a) },
  on(type, cb, opts) { registered.listeners.push({ type, opts }); },
  commands: { register: (def) => registered.commands.push(def) },
  tools: { register: (def) => registered.tools.push(def) },
  // optional-injection stub: simulate webServer being available
  inject(names, callback) {
    if (Array.isArray(names) && names.includes("webServer")) {
      const child = {
        webServer: { register: (route) => registered.routes.push(route) },
        effect(cb) { const disposer = cb(); return () => { if (typeof disposer === "function") disposer(); }; }
      };
      callback(child);
    }
    return { dispose() {} };
  }
};

const { apply, inject, name } = await import("../lib/index.js");
apply(ctx, ctx.config); // cordis convention: apply(ctx, config)

const problems = [];
if (name !== "retro") problems.push(`name=${name}`);
if (!inject.includes("commands")) problems.push("inject.commands missing");
const cmdNames = registered.commands.map((c) => c.name);
for (const expected of ["retro", "weekly", "blog"]) {
  if (!cmdNames.includes(expected)) problems.push(`command /${expected} not registered (got: ${cmdNames.join(",")})`);
}
const toolNames = registered.tools.map((t) => t.name);
for (const expected of ["retro_capture", "retro_draft"]) {
  if (!toolNames.includes(expected)) problems.push(`tool ${expected} not registered (got: ${toolNames.join(",")})`);
}
if (registered.listeners.length === 0) problems.push("no session/event listener attached");
const hasFirehose = registered.listeners.some((l) => l.type === "session/event" && l.opts?.global === true);
if (!hasFirehose) problems.push("session/event global listener missing");

const panelRoute = registered.routes.find((r) => r.kind === "exact" && r.path === "/retro/api");
if (!panelRoute) problems.push("GET /retro/api route not registered (webServer optional inject)");
if (panelRoute && typeof panelRoute.handler !== "function") problems.push("panel route handler missing");

const stateDir = path.join(tmp, "retro-state");
if (!existsSync(stateDir)) problems.push("retro state dir not created");
const vaultStaging = path.join(tmp, "vault", "Index", "06_Retro", "_retro");
if (!existsSync(vaultStaging)) problems.push("vault staging dir not created (config not honored)");

if (problems.length > 0) {
  console.error("FAIL:\n- " + problems.join("\n- "));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
console.log(`PASS: name=${name}, inject=[${inject.join(",")}], commands=${cmdNames.join(",")}, tools=${toolNames.join(",")}, listeners=${registered.listeners.map((l) => l.type).join(",")}`);
rmSync(tmp, { recursive: true, force: true });
