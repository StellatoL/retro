// 公共工具：仅依赖 Node 内置模块。
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

/** 先写临时文件，再重命名替换目标，避免直接写出半截内容。 */
export function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      renameSync(tmp, filePath);
    } catch {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** 尝试读取文件，缺失或无法读取时返回 undefined。 */
export function readOptional(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** 将相对路径限制在指定根目录内，拒绝越界、受保护目录和绝对路径。 */
export function safeJoin(root, rel) {
  if (typeof root !== "string" || !root.trim()) throw new Error("retro: 根目录未配置");
  if (typeof rel !== "string" || !rel.trim()) throw new Error("retro: 相对路径不能为空");
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-z]:/i.test(rel)) {
    throw new Error(`retro: 必须使用相对路径（${rel}）`);
  }
  const normalized = rel.split(/[\\/]/).join(path.sep);
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, normalized);
  const relCheck = path.relative(rootResolved, candidate);
  if (relCheck === "") throw new Error(`retro: 不能把根目录本身作为文件目标（${rel}）`);
  if (outsideRoot(relCheck)) throw new Error(`retro: 路径越出允许目录 ${root}（${rel}）`);
  for (const seg of normalized.split(path.sep)) {
    if ([".obsidian", ".git", ".trash"].includes(seg.toLowerCase().replace(/[. ]+$/, ""))) {
      throw new Error(`retro: 不能访问受保护目录 "${seg}"`);
    }
  }
  // 检查已存在的目录链接；尚未创建的末级路径按其真实父目录计算。
  const realRoot = resolveExistingPath(rootResolved);
  const realTarget = resolveExistingPath(candidate);
  const actualRelative = path.relative(realRoot, realTarget);
  if (!actualRelative || outsideRoot(actualRelative)) throw new Error(`retro: 目录链接使路径越出允许目录（${rel}）`);
  if (actualRelative.split(path.sep).some((seg) => [".obsidian", ".git", ".trash"].includes(seg.toLowerCase().replace(/[. ]+$/, "")))) {
    throw new Error(`retro: 目录链接指向受保护目录（${rel}）`);
  }
  return candidate;
}

function outsideRoot(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveExistingPath(file) {
  let current = file;
  const missing = [];
  while (true) {
    try {
      lstatSync(current);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.join(realpathSync.native(current), ...missing);
}

/** 生成文件名主题：保留中日韩文字，拉丁字母小写，分隔符改为连字符。 */
export function slugify(text, max = 60) {
  const s = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max) || "untitled";
}

/** 按本地时区生成 YYYY-MM-DD 日期。 */
export function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 按本地时区生成 YYYY-MM-DD HH:mm 时间。 */
export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${todayStamp()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成可用于 Windows 文件名的 YYYY-MM-DD-HHmm 时间戳，不含冒号。 */
export function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 在目录内选择未占用的 Markdown 文件名；重名时依次追加 -2、-3 等序号。
 */
export function uniqueFileName(dir, base) {
  let name = base;
  let n = 2;
  while (existsSync(path.join(dir, `${name}.md`))) {
    name = `${base}-${n++}`;
  }
  return `${name}.md`;
}

/** 生成博客 frontmatter 使用的 ISO 日期部分。 */
export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** 生成短随机标识后缀。 */
export function shortId(len = 5) {
  return Math.random().toString(36).slice(2, 2 + len);
}

/** 从 DSH 消息的字符串或内容块中提取文本。 */
export function textOf(message) {
  if (message == null) return "";
  const content = message.content ?? message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return String(block.text ?? "");
        if (block?.type === "tool-result") {
          const inner = block.content;
          return typeof inner === "string" ? inner : JSON.stringify(inner ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const inner = content.text ?? content.content;
    return typeof inner === "string" ? inner : JSON.stringify(content);
  }
  return String(content ?? "");
}

/** 清理标题开头的井号及多余 Markdown 修饰符。 */
export function cleanTitle(text) {
  return String(text ?? "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/[#*_`]/g, "")
    .trim();
}

/** 解析 frontmatter 的有限 YAML 子集：字符串、数字、布尔值与字符串数组。 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let currentKey = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = /^\s*-\s*(.*)$/.exec(line);
    if (listItem && currentKey) {
      const arr = data[currentKey];
      if (Array.isArray(arr)) arr.push(unquote(listItem[1]));
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { currentKey = null; continue; }
    currentKey = kv[1];
    const value = kv[2].trim();
    if (value === "" || value === "[]") { data[currentKey] = []; continue; }
    if (value.startsWith("[")) {
      data[currentKey] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
      continue;
    }
    data[currentKey] = scalar(value);
  }
  return { data, body: text.slice(m[0].length) };
}

function unquote(s) {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function scalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (value !== "" && Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(value)) return num;
  return unquote(value);
}

/** 将字符串、数字、布尔值或数组渲染为简单 YAML frontmatter。 */
export function renderFrontmatter(entries) {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${key}: []`); continue; }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlString(item)}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlString(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  if (/^[\w\u4e00-\u9fff\-\/\.\s]+$/u.test(s) && !/^[-?][\s]/.test(s)) {
    return s.includes(": ") ? JSON.stringify(s) : s;
  }
  return JSON.stringify(s);
}

/** 替换支持的 Templater 表达式，移除其他表达式并返回警告列表。 */
export function renderTemplater(text, vars = {}) {
  const warnings = [];
  const replaced = text.replace(/<%([\s\S]*?)%>/g, (full, expr) => {
    const e = expr.trim();
    const m = /tp\.file\.(creation_date|last_modified_date|title|basename)/.exec(e);
    if (m) {
      const key = m[1] === "title" || m[1] === "basename" ? "title" : m[1] === "creation_date" ? "createDate" : "modifyDate";
      if (vars[key] !== undefined) return vars[key];
    }
    warnings.push(full.trim());
    return "";
  });
  return { text: replaced, warnings };
}

/** 从知识库相对路径读取模板，缺失或无法访问时使用内置内容。 */
export function loadTemplate(cfg, templateKey, fallbackText) {
  const rel = cfg.templates?.[templateKey];
  if (rel) {
    try {
      const abs = safeJoin(cfg.vaultPath, rel);
      const text = readOptional(abs);
      if (text !== undefined) return text;
    } catch { /* 路径不可用时继续使用内置模板 */ }
  }
  return fallbackText;
}

/** 返回知识库模板缺失时使用的内置模板。 */
export function fallbackTemplate(kind) {
  if (kind === "experience") {
    return [
      "---",
      "Type: dsh_retro",
      "Status: drafted",
      "Tags: [experience]",
      "---",
      "",
      "# {{title}}",
      "",
      "## 项目目标",
      "",
      "## 环境与栈",
      "",
      "## 关键过程",
      "",
      "## 踩坑与根因",
      "",
      "## 关键经验",
      "",
      "## 行动项",
      "",
      "## 参考链接",
      ""
    ].join("\n");
  }
  if (kind === "permanent") {
    return [
      "---",
      "Type: permanent",
      "Tags: []",
      "Source:",
      "---",
      "",
      "# 结论一句话",
      "",
      "## Use",
      "",
      "## Model",
      "",
      "## Example",
      "",
      "## Pitfalls",
      "",
      "## Links",
      ""
    ].join("\n");
  }
  if (kind === "weekly") {
    return [
      "---",
      "Type: weekly",
      "---",
      "",
      "# 本周汇总 {{title}}",
      "",
      "## 本周三件事",
      "",
      "## 推进情况",
      "",
      "## 踩坑",
      "",
      "## 可复用经验",
      "",
      "## 待审清单",
      "",
      "## 下周重点",
      ""
    ].join("\n");
  }
  return "";
}

/** 截断过长文本，并附加明确的截断标记。 */
export function clip(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[截断]`;
}

/** 结构化字段与 Markdown 二级标题的对应关系（用于面板内联编辑的局部替换）。 */
const SECTION_ALIASES = {
  goal: ["项目目标", "目标"],
  env: ["环境与栈", "环境"],
  process: ["关键过程", "过程"],
  pitfalls: ["踩坑与根因", "踩坑"],
  lessons: ["关键经验", "经验"],
  actions: ["行动项"]
};

const QUESTIONS_ALIASES = ["待确认问题"];

function normalizeHeadingText(text) {
  return String(text ?? "").replace(/^#{1,6}\s*/, "").replace(/[：:\s]+$/g, "").trim();
}

/**
 * 在 Markdown 中定位指定标题的二级小节，返回其正文行区间。
 * @returns {{ heading: number, start: number, end: number } | null} 标题行号与正文起止（不含标题行）。
 */
function locateSection(lines, aliases) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^##\s+(.+)$/.exec(lines[i]);
    if (!match) continue;
    const name = normalizeHeadingText(match[1]);
    if (!aliases.some((alias) => name.includes(alias))) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{1,2}\s+/.test(lines[j])) { end = j; break; }
    }
    return { heading: i, start: i + 1, end };
  }
  return null;
}

/**
 * 非破坏性合并卡片正文：只替换已知小节的正文，用户手写的其他章节原样保留。
 * @param {string} rawMd - 原始 Markdown。
 * @param {{ sections?: Record<string, string>, answers?: Array<{question: string, answer: string}> }} patch
 * @returns {string} 合并后的 Markdown。
 */
export function patchMarkdownSections(rawMd, { sections = {}, answers = [] } = {}) {
  const lines = String(rawMd ?? "").split(/\r?\n/);
  for (const [key, body] of Object.entries(sections ?? {})) {
    if (typeof body !== "string") continue;
    const aliases = SECTION_ALIASES[key];
    if (!aliases) continue;
    const found = locateSection(lines, aliases);
    const block = ["", ...body.split(/\r?\n/), ""];
    if (found) {
      lines.splice(found.start, found.end - found.start, ...block);
    } else {
      lines.push("", `## ${aliases[0]}`, ...block);
    }
  }
  if (Array.isArray(answers) && answers.length > 0) {
    const items = answers
      .filter((entry) => entry && typeof entry.answer === "string" && entry.answer.trim())
      .map((entry) => `- ${String(entry.question ?? "（问题）").trim()} → ${entry.answer.trim()}`);
    if (items.length > 0) {
      const found = locateSection(lines, QUESTIONS_ALIASES);
      if (found) {
        const body = lines.slice(found.start, found.end);
        // 去掉正文尾部空行后再追加，避免每次合并都累积空行。
        while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
        lines.splice(found.start, found.end - found.start, ...body, ...items, "");
      } else {
        lines.push("", "## 待确认问题", ...items, "");
      }
    }
  }
  return lines.join("\n");
}
