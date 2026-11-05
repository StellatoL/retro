// 插件宿主入口：导出 Cordis 所需的 name、inject、apply。
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig } from "./config.js";
import { RetroStore } from "./store.js";
import { retroDir } from "./config.js";
import { attachCollector } from "./collectors.js";
import { registerCommands } from "./commands.js";
import { registerTools } from "./tools.js";
import { ensureDirs } from "./settler.js";
import { ensureSkillFiles } from "./evolvor.js";
import { registerPanelApi, registerDetailApi, registerActionApi, registerEventsApi, registerClientDiagnosticsApi } from "./api.js";

const name = "retro";
const inject = ["commands", "llm", "sessionQuery", "tools"];

/**
 * 记录一条宿主侧启动面包屑（版本 + 客户端文件实际大小/时间），
 * 与浏览器端上报写入同一份 client-diag.log，便于区分"宿主没加载"与"客户端没跑起来"。
 */
function writeHostBreadcrumb() {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const clientPath = join(dirname(pkgPath), "dsh-retro/lib/client.js");
    const stat = statSync(clientPath);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      phase: "host-apply",
      version: pkg.version,
      clientPath,
      clientSize: stat.size,
      clientMtime: stat.mtime.toISOString()
    });
    mkdirSync(retroDir(), { recursive: true });
    appendFileSync(join(retroDir(), "client-diag.log"), `${line}\n`, "utf8");
  } catch { /* 面包屑失败不影响插件加载 */ }
}

// Cordis 通过 apply(ctx, config) 的第二个参数传入行配置。
// 未注入 config 服务时，不能从 ctx.config 读取配置。
function apply(ctx, config) {
  try {
    const cfg = loadConfig(config ?? {});
    const store = new RetroStore(retroDir());

    // 在知识库中准备暂存、提案、条目与经验库目录。
    try {
      ensureDirs(cfg);
    } catch (error) {
      ctx.logger?.warn?.(`[retro] 初始化目录失败：${String(error?.message ?? error)}（可用 /retro config vaultPath 修正）`);
    }

    // 首次加载时安装配套 retro-writing 技能，已有文件保持原样。
    const skill = ensureSkillFiles();
    if (!skill.ok) ctx.logger?.warn?.(`[retro] skill 安装失败：${skill.error}`);

    // 订阅会话事件流与独立的销毁通知。
    attachCollector(ctx, store, cfg);

    // 注册人工命令与模型工具。
    registerCommands(ctx, store, cfg);
    registerTools(ctx, store, cfg);

    // webServer 存在时提供只读面板与详情 API；
    // 受控写接口默认关闭（只注册路由，请求时按开关拒绝），事件流用于面板增量刷新。
    try {
      registerPanelApi(ctx, store, cfg);
      registerDetailApi(ctx, store, cfg);
      registerActionApi(ctx, store, cfg);
      registerEventsApi(ctx, store, cfg);
      // 客户端自诊断：浏览器端错误写回 client-diag.log，便于排查"插件不显示"。
      registerClientDiagnosticsApi(ctx, cfg);
    } catch (error) {
      ctx.logger?.warn?.(`[retro] 面板 API 注册失败：${String(error?.message ?? error)}`);
    }

    // 记录宿主启动面包屑：确认宿主加载的版本与客户端文件的实际状态。
    writeHostBreadcrumb();

    // 启动时检查周报间隔，提醒也会在 /retro queue 中展示。
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
    // 将初始化异常写到状态目录中，记录失败本身不再抛出异常。
    try {
      mkdirSync(retroDir(), { recursive: true });
      writeFileSync(join(retroDir(), "apply-error.log"), `${new Date().toISOString()}\n${error?.stack ?? String(error)}\n`, { flag: "a" });
    } catch { /* 日志写入失败不再阻断宿主 */ }
  }
}

export { apply, inject, name };
