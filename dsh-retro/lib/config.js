// dsh-retro: configuration (code defaults < row config < runtime file).
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { atomicWrite, readOptional } from "./util.js";

export const DEFAULTS = {
  // 个人路径不硬编码在代码里（隐私）：通过运行时配置 ~/.dsh/retro/config.json
  // 或环境变量 DSH_RETRO_VAULT / DSH_RETRO_BLOG / DSH_RETRO_BLOG_URL 提供
  // （环境变量在 loadConfig 中惰性填充，见下）。
  vaultPath: "",
  blogPath: "",
  blogBaseUrl: "",
  // 复盘系统统一放在 Index/06_Retro/ 下（用户确认的布局）；
  // 落库目录也必须在 Index 下，默认 03_Full_Notes/04_Retro（03 内的复盘子文件夹）。
  stagingDir: "Index/06_Retro/_retro",       // 复盘卡片暂存区（人工审阅）
  experienceRoot: "Index/06_Retro/经验库",    // 永久经验库
  proposalsDir: "Index/06_Retro/_proposals",  // 进化提案（skill/AGENTS.md 待采纳）
  entriesDir: "Index/06_Retro/_entries",      // 经验条目草稿
  settleDirs: ["Index/03_Full_Notes/04_Retro", "Index/04_Projects", "Index/06_Retro/经验库"],
  readWhitelist: ["Index"],
  templates: {
    experience: "Index/99_system/_templates/experience.md",
    permanent: "Index/99_system/_templates/permanent.md",
    weekly: "Index/99_system/_templates/weekly.md"
  },
  autoProposeOnGoalComplete: true,
  weeklyReminderDays: 7,
  blogAutoPush: false,
  llmProvider: "deepseek-official",
  llmModel: "deepseek-v4-flash",
  distillMaxChars: 30000,
  chunkChars: 12000
};

/** Plugin-owned state/config dir. Overridable via DSH_RETRO_DIR (tests) or $DSH_HOME/retro. */
export function retroDir() {
  if (process.env.DSH_RETRO_DIR) return process.env.DSH_RETRO_DIR;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "retro");
}

export function configPath() {
  return path.join(retroDir(), "config.json");
}

function readFileConfig() {
  try {
    const raw = readOptional(configPath());
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === undefined) continue;
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      out[key] && typeof out[key] === "object" && !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Effective config: DEFAULTS < rowConfig (cordis row) < runtime file (~/.dsh/retro/config.json);
 * env vars (DSH_RETRO_VAULT / DSH_RETRO_BLOG / DSH_RETRO_BLOG_URL) fill in only when still empty. */
export function loadConfig(rowConfig = {}) {
  const file = readFileConfig();
  const merged = deepMerge(deepMerge(DEFAULTS, rowConfig), file);
  if (!merged.vaultPath && process.env.DSH_RETRO_VAULT) merged.vaultPath = process.env.DSH_RETRO_VAULT;
  if (!merged.blogPath && process.env.DSH_RETRO_BLOG) merged.blogPath = process.env.DSH_RETRO_BLOG;
  if (!merged.blogBaseUrl && process.env.DSH_RETRO_BLOG_URL) merged.blogBaseUrl = process.env.DSH_RETRO_BLOG_URL;
  return merged;
}

/** Persist a partial update to the runtime config file. */
export function saveConfig(patch) {
  const current = readFileConfig();
  const next = deepMerge(current, patch);
  atomicWrite(configPath(), JSON.stringify(next, null, 2));
  return next;
}

/** Basic environment sanity checks; returns a list of warnings (never throws). */
export function validateConfig(cfg) {
  const warnings = [];
  if (!cfg.vaultPath || !existsSync(cfg.vaultPath)) {
    warnings.push(`vaultPath 不存在或未配置：${cfg.vaultPath}（请运行 /retro config vaultPath <路径>）`);
  }
  if (!cfg.blogPath || !existsSync(cfg.blogPath)) {
    warnings.push(`blogPath 不存在或未配置：${cfg.blogPath}（请运行 /retro config blogPath <路径>）`);
  }
  return warnings;
}

/** Human-readable config dump (paths only; no secrets involved). */
export function renderConfig(cfg) {
  const rows = [
    ["vaultPath", cfg.vaultPath],
    ["blogPath", cfg.blogPath],
    ["stagingDir", cfg.stagingDir],
    ["experienceRoot", cfg.experienceRoot],
    ["proposalsDir", cfg.proposalsDir],
    ["entriesDir", cfg.entriesDir],
    ["settleDirs", cfg.settleDirs.join(", ")],
    ["readWhitelist", cfg.readWhitelist.join(", ")],
    ["autoProposeOnGoalComplete", String(cfg.autoProposeOnGoalComplete)],
    ["weeklyReminderDays", String(cfg.weeklyReminderDays)],
    ["blogAutoPush", String(cfg.blogAutoPush)],
    ["llmProvider", cfg.llmProvider],
    ["llmModel", cfg.llmModel],
    ["configDir", retroDir()]
  ];
  return rows.map(([k, v]) => `${k}: ${v}`).join("\n");
}
