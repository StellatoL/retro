// dsh-retro: shared utilities (no external dependencies).
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Atomic file write: temp file + rename (survives partial writes). */
export function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try { renameSync(tmp, filePath); } catch { /* Windows retry */ }
    throw error;
  }
}

/** Read a file, returning `undefined` when missing. */
export function readOptional(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Join a relative path under a root, rejecting traversal, hidden tool dirs, and absolute paths. */
export function safeJoin(root, rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("retro: empty relative path");
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, rel);
  const relCheck = path.relative(rootResolved, candidate);
  if (relCheck === "" ) throw new Error(`retro: refusing to write the root directory itself (${rel})`);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error(`retro: path escapes ${root} (${rel})`);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === ".obsidian" || seg === ".git" || seg === ".trash") {
      throw new Error(`retro: refusing to touch protected directory "${seg}"`);
    }
  }
  return candidate;
}

/** Slugify a title for file names: keeps CJK, lowercases latin, dashes for separators. */
export function slugify(text, max = 60) {
  const s = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max) || "untitled";
}

/** Local date stamp YYYY-MM-DD. */
export function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local datetime stamp YYYY-MM-DD HH:mm. */
export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${todayStamp()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO date (date only) for blog frontmatter. */
export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Short random id suffix. */
export function shortId(len = 5) {
  return Math.random().toString(36).slice(2, 2 + len);
}

/** Extract text from a harness message: string content or content blocks. */
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

/** Parse a markdown file's frontmatter (minimal YAML subset: strings, numbers, booleans, string arrays). */
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

/** Render a minimal YAML frontmatter block (values: string/number/boolean/array). */
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

/** Strip Templater syntax from a rendered template; returns { text, warnings }. */
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

/** Read a markdown template relative to vaultPath; fallback content when missing. */
export function loadTemplate(cfg, templateKey, fallbackText) {
  const rel = cfg.templates?.[templateKey];
  if (rel) {
    try {
      const abs = safeJoin(cfg.vaultPath, rel);
      const text = readOptional(abs);
      if (text !== undefined) return text;
    } catch { /* fall through */ }
  }
  return fallbackText;
}

/** Build the fallback (built-in) templates when the vault template is missing. */
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

/** Truncate long text with an explicit marker. */
export function clip(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[截断]`;
}
