// 配置优先级：默认值 < Cordis 行配置 < 运行时文件；环境变量仅补齐空路径。
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
  // 默认使用 Index/06_Retro/ 管理复盘过程，正式复盘放在 03_Full_Notes/04_Retro。
  // 如调整布局，应同时配置暂存、落库与读取白名单。
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
  chunkChars: 12000,
  // 面板写接口默认关闭：GET /retro/api 对本机进程无鉴权，写能力必须显式开启。
  // 只允许通过 CLI（/retro config security.enableWriteApi true）或手改配置文件开启，
  // 严禁由 HTTP 接口自我提权。
  security: {
    enableWriteApi: false,
    exposeVaultNotes: false,
    requireDoubleConfirm: true
  },
  // 暂存文件归档：结算后原地保留，由 /retro cleanup 归档到 .archived/YYYY-MM。
  storage: {
    archiveRetentionDays: 30,
    stagingGraceHours: 24
  },
  // 多工作区：workspaces 为空时沿用上面的单库配置，行为与旧版本完全一致。
  // 每项形如 { id, name, vaultPath, blogPath? }；activeWorkspace 为空表示不启用。
  workspaces: [],
  activeWorkspace: ""
};

/** 状态与配置目录：优先使用 DSH_RETRO_DIR，否则使用 DSH_HOME 下的 retro。 */
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

/** 合并默认值、Cordis 行配置与运行时文件；随后按激活工作区覆盖路径，环境变量只补空值。 */
export function loadConfig(rowConfig = {}) {
  const file = readFileConfig();
  const merged = deepMerge(deepMerge(DEFAULTS, rowConfig), file);
  applyActiveWorkspace(merged);
  if (!merged.vaultPath && process.env.DSH_RETRO_VAULT) merged.vaultPath = process.env.DSH_RETRO_VAULT;
  if (!merged.blogPath && process.env.DSH_RETRO_BLOG) merged.blogPath = process.env.DSH_RETRO_BLOG;
  if (!merged.blogBaseUrl && process.env.DSH_RETRO_BLOG_URL) merged.blogBaseUrl = process.env.DSH_RETRO_BLOG_URL;
  return merged;
}

/**
 * 按 activeWorkspace 覆盖 vaultPath / blogPath。
 * 未配置工作区或 id 不存在时不做任何修改，保持单库语义。
 * @param {object} merged - 已合并的配置对象（原地修改并返回）。
 */
export function applyActiveWorkspace(merged) {
  const list = Array.isArray(merged.workspaces) ? merged.workspaces : [];
  const activeId = typeof merged.activeWorkspace === "string" ? merged.activeWorkspace.trim() : "";
  if (!activeId) return merged;
  const workspace = list.find((item) => item && item.id === activeId);
  if (!workspace) return merged;
  if (typeof workspace.vaultPath === "string" && workspace.vaultPath.trim()) merged.vaultPath = workspace.vaultPath;
  if (typeof workspace.blogPath === "string" && workspace.blogPath.trim()) merged.blogPath = workspace.blogPath;
  return merged;
}

/** 列出工作区（供命令与面板展示）；未配置时返回空数组。 */
export function listWorkspaces(cfg) {
  const list = Array.isArray(cfg?.workspaces) ? cfg.workspaces : [];
  const active = typeof cfg?.activeWorkspace === "string" ? cfg.activeWorkspace : "";
  return list
    .filter((item) => item && typeof item.id === "string" && item.id)
    .map((item) => ({
      id: item.id,
      name: item.name || item.id,
      vaultPath: item.vaultPath ?? "",
      blogPath: item.blogPath ?? "",
      active: item.id === active
    }));
}

/** 按点号路径读取配置，缺失时返回 undefined（支持 security.enableWriteApi 这类分组键）。 */
export function getConfigPath(source, key) {
  if (!key.includes(".")) return source?.[key];
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), source);
}

/** 按点号路径写入配置对象，自动创建中间层。 */
export function setConfigPath(target, key, value) {
  const parts = key.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return target;
}

/** 将局部配置更新合并并持久化到运行时文件；点号键展开为嵌套对象。 */
export function saveConfig(patch) {
  const nested = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key.includes(".")) setConfigPath(nested, key, value);
    else nested[key] = value;
  }
  const current = readFileConfig();
  const next = deepMerge(current, nested);
  atomicWrite(configPath(), JSON.stringify(next, null, 2));
  return next;
}

/** 按配置声明的类型解析命令输入，避免把路径、数组和分段长度保存成错误类型。 */
export function parseConfigValue(key, raw) {
  // 工作区是结构化配置，统一走 /retro workspace，避免手写 JSON 破坏结构。
  if (key === "workspaces" || key === "activeWorkspace") {
    throw new Error("工作区请使用 /retro workspace 命令管理（list / use / add / remove）");
  }
  const sample = getConfigPath(DEFAULTS, key);
  if (sample === undefined) throw new Error(`未知配置项：${key}`);
  if (Array.isArray(sample)) {
    const values = raw.startsWith("[") ? JSON.parse(raw) : raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${key} 必须是非空字符串数组，可用逗号分隔`);
    }
    return values;
  }
  if (typeof sample === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error(`${key} 只能为 true 或 false`);
    return raw === "true";
  }
  if (typeof sample === "number") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} 必须为正整数`);
    return value;
  }
  if (sample && typeof sample === "object") {
    // templates 是"整组替换"的特例；security / storage 只允许逐个点号键修改，
    // 避免一次误输入把整组安全开关覆盖成未声明的值。
    if (key !== "templates") {
      throw new Error(`${key} 是分组配置，请使用点号键，例如 ${key}.${Object.keys(sample)[0]}`);
    }
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([name, entry]) => !Object.hasOwn(sample, name) || typeof entry !== "string")) {
      throw new Error(`${key} 必须是包含 experience、permanent 或 weekly 路径的 JSON 对象`);
    }
    return value;
  }
  return raw;
}

/** 检查必要路径，返回供命令和日志展示的提示。 */
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

/** 将常用配置与状态目录格式化为可读文本。 */
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
    ["security.enableWriteApi", String(cfg.security?.enableWriteApi)],
    ["security.exposeVaultNotes", String(cfg.security?.exposeVaultNotes)],
    ["security.requireDoubleConfirm", String(cfg.security?.requireDoubleConfirm)],
    ["storage.archiveRetentionDays", String(cfg.storage?.archiveRetentionDays)],
    ["storage.stagingGraceHours", String(cfg.storage?.stagingGraceHours)],
    ["activeWorkspace", cfg.activeWorkspace || "（未启用）"],
    ["workspaces", listWorkspaces(cfg).map((item) => `${item.id}${item.active ? "*" : ""}`).join(", ") || "（未配置）"],
    ["configDir", retroDir()]
  ];
  return rows.map(([k, v]) => `${k}: ${v}`).join("\n");
}
