// dsh-retro: plugin entry — { name, inject, apply }.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, validateConfig } from "./config.js";
import { RetroStore } from "./store.js";
import { retroDir } from "./config.js";
import { attachCollector } from "./collectors.js";
import { registerCommands } from "./commands.js";
import { registerTools } from "./tools.js";
import { ensureDirs } from "./settler.js";
import { ensureSkillFiles } from "./evolvor.js";
import { registerPanelApi } from "./api.js";

const name = "retro";
const inject = ["commands", "llm", "sessionQuery", "tools"];

// Cordis calls apply(ctx, config): config is the SECOND argument (the row's
// config). `ctx.config` is NOT available without "config" in inject.
function apply(ctx, config) {
  try {
    const cfg = loadConfig(config ?? {});
    const store = new RetroStore(retroDir());

    // Host-side dirs (staging + experience root under the vault).
    try {
      ensureDirs(cfg);
    } catch (error) {
      ctx.logger?.warn?.(`[retro] 初始化目录失败：${String(error?.message ?? error)}（可用 /retro config vaultPath 修正）`);
    }

    // First-run: install the bundled retro-writing skill (~/.dsh/skills).
    const skill = ensureSkillFiles();
    if (!skill.ok) ctx.logger?.warn?.(`[retro] skill 安装失败：${skill.error}`);

    // Event collection (session/event firehose).
    attachCollector(ctx, store, cfg);

    // Human-facing commands + model-facing tools.
    registerCommands(ctx, store, cfg);
    registerTools(ctx, store, cfg);

    // Web panel API (GET /retro/api) — optional webServer service.
    try {
      registerPanelApi(ctx, store);
    } catch (error) {
      ctx.logger?.warn?.(`[retro] 面板 API 注册失败：${String(error?.message ?? error)}`);
    }

    // Boot-time weekly check (T4): log a reminder; /retro queue surfaces it.
    const meta = store.getMeta();
    if (meta.lastWeeklyCheck) {
      const days = Math.floor((Date.now() - new Date(meta.lastWeeklyCheck).getTime()) / 86400000);
      if (days >= (cfg.weeklyReminderDays ?? 7)) {
        ctx.logger?.info?.(`[retro] 距上次周汇总已 ${days} 天，运行 /weekly 生成本周复盘`);
      }
    }

    for (const warning of validateConfig(cfg)) {
      ctx.logger?.warn?.(`[retro] ${warning}`);
    }
    ctx.logger?.info?.("[retro] dsh-retro 已加载（经验复盘管线）");
  } catch (error) {
    ctx.logger?.error?.("[retro] 插件初始化失败", error);
    // Dump the failure next to the store for diagnosability (never throws).
    try {
      mkdirSync(retroDir(), { recursive: true });
      writeFileSync(join(retroDir(), "apply-error.log"), `${new Date().toISOString()}\n${error?.stack ?? String(error)}\n`, { flag: "a" });
    } catch { /* ignore */ }
  }
}

export { apply, inject, name };
