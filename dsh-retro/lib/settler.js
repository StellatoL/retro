// 沉淀层：通过白名单写暂存文件、渲染模板，并处理人工确认的落库或丢弃。
// 所有文件操作均在宿主侧执行。
import path from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWrite, loadTemplate, renderTemplater, safeJoin, fallbackTemplate, nowStamp, stampNow, uniqueFileName, slugify, readOptional, cleanTitle, clip } from "./util.js";

/** 返回知识库内经过校验的卡片暂存目录绝对路径。 */
export function stagingRoot(cfg) {
  requireVault(cfg);
  return safeJoin(cfg.vaultPath, cfg.stagingDir);
}

/** 返回知识库内经过校验的经验库绝对路径。 */
export function experienceRoot(cfg) {
  requireVault(cfg);
  return safeJoin(cfg.vaultPath, cfg.experienceRoot);
}

/** 返回知识库内经过校验的提案目录绝对路径。 */
export function proposalsRoot(cfg) {
  requireVault(cfg);
  return safeJoin(cfg.vaultPath, cfg.proposalsDir ?? "Index/06_Retro/_proposals");
}

/** 返回知识库内经过校验的条目草稿目录绝对路径。 */
export function entriesRoot(cfg) {
  requireVault(cfg);
  return safeJoin(cfg.vaultPath, cfg.entriesDir ?? "Index/06_Retro/_entries");
}

/** 知识库未配置时直接报错，避免写入当前工作目录。 */
function requireVault(cfg) {
  if (typeof cfg.vaultPath !== "string" || !cfg.vaultPath.trim()) throw new Error("vaultPath 未配置：运行 /retro config vaultPath <路径> 或设置环境变量 DSH_RETRO_VAULT");
}

/**
 * 将 _entries/ 和 _proposals/ 前缀分别路由到条目与提案根目录，
 * 其他相对路径路由到卡片暂存区。
 */
export function ownedRootFor(cfg, relPath) {
  if (relPath.startsWith("_entries/")) return entriesRoot(cfg);
  if (relPath.startsWith("_proposals/")) return proposalsRoot(cfg);
  return stagingRoot(cfg);
}

/** 创建插件在知识库中使用的目录。 */
export function ensureDirs(cfg) {
  if (!cfg.vaultPath) return;
  const roots = [stagingRoot(cfg), proposalsRoot(cfg), entriesRoot(cfg), experienceRoot(cfg)];
  for (const root of roots) mkdirSync(root, { recursive: true });
}

/**
 * 在插件的卡片、提案或条目暂存根目录下写入文件。
 * 拒绝越出相应根目录以及访问 .obsidian、.git、.trash。
 */
export function writeStaging(cfg, relPath, content, { store, actor = "retro" } = {}) {
  requireVault(cfg);
  const root = ownedRootFor(cfg, relPath);
  const target = safeJoin(root, relPath.replace(/^_entries\/|^_proposals\//, ""));
  atomicWrite(target, content);
  store?.audit({ actor, action: "write-staging", target: relPath, ok: true });
  return target;
}

/** 按相同路径限制读取插件暂存文件。 */
export function readStaging(cfg, relPath) {
  requireVault(cfg);
  const root = ownedRootFor(cfg, relPath);
  const target = safeJoin(root, relPath.replace(/^_entries\/|^_proposals\//, ""));
  const text = readOptional(target);
  if (text === undefined) throw new Error(`暂存文件不存在：${relPath}`);
  return text;
}

/** 渲染知识库模板或内置模板，替换支持的 Templater 表达式。 */
export function renderCardTemplate(cfg, kind, vars) {
  const template = loadTemplate(cfg, kind, fallbackTemplate(kind));
  const { text, warnings } = renderTemplater(template, vars);
  if (warnings.length > 0 && typeof vars._warnings === "object") {
    vars._warnings.push(...warnings.map((w) => `模板中存在未渲染的 Templater 表达式：${w.slice(0, 60)}`));
  }
  return text;
}

/** 将模板中的 {{title}} 占位符替换为具体标题。 */
function fillTitle(text, title) {
  return text.replaceAll("{{title}}", title ?? "未命名复盘");
}

/**
 * 将渲染后的模板、提炼正文和待确认问题合并成一个文件，供用户审阅。
 */
export function draftCardFiles(cfg, store, card, { markdown, questions = [], templateKind = "experience", actor = "command" }) {
  const warnings = [];
  const frontmatter = [
    "---",
    "Type: dsh_retro_card",
    `Status: ${card.status}`,
    `createDate: ${card.createdAt.slice(0, 16).replace("T", " ")}`,
    `modifyDate: ${nowStamp()}`,
    `cardId: ${card.id}`,
    `sessionIds: [${(card.sessionIds ?? []).map((s) => `"${s}"`).join(", ")}]`,
    "Tags: [experience]",
    "---",
    ""
  ].join("\n");

  const body = [
    markdown.trim(),
    "",
    "---",
    "",
    "## 待确认问题",
    "",
    ...(questions.length > 0
      ? questions.map((q, i) => `${i + 1}. ${q}`)
      : ["（初稿未生成提问清单——请自行判断需要补充确认的内容）"]),
    "",
    "> 审阅方式：直接在本文件中修改，然后运行 `/retro review <cardId> keep` 确认落库；",
    "> 或运行 `/retro review <cardId> edit <修改意见>` 让我按意见修订。",
    ""
  ].join("\n");

  const content = `${frontmatter}${body}`;
  // 统一命名：日期-时间-简要主题（可读、可排序、不依赖内部 id）
  const base = `${stampNow()}-${slugify(cleanTitle(card.title))}`;
  const relPath = uniqueFileName(stagingRoot(cfg), base);
  const target = writeStaging(cfg, relPath, content, { store, actor });
  store.updateCard(card.id, { stagingPath: relPath, status: "drafted" });
  return { relPath, target, warnings };
}

/** 返回允许落库的知识库相对目录。 */
function resolveSettleDir(cfg, dir) {
  const allowed = cfg.settleDirs ?? ["Index/03_Full_Notes/04_Retro", "Index/04_Projects"];
  const candidate = dir ?? allowed[0];
  if (!allowed.includes(candidate)) {
    throw new Error(`目标目录 "${candidate}" 不在允许列表 ${allowed.join(" / ")} 中（--dir 只能选这些）`);
  }
  return candidate;
}

/**
 * 人工确认后读取用户可能已编辑的暂存文件，
 * 将正式笔记写入选定的允许目录，并更新状态。
 */
export function settleCard(cfg, store, card, { action, dir, note = null, actor = "command" }) {
  if (action === "discard") {
    store.updateCard(card.id, { status: "discarded", updatedAt: new Date().toISOString() });
    store.audit({ actor, action: "settle-discard", target: card.id, ok: true, note });
    return { ok: true, status: "discarded", message: `卡片 ${card.id} 已标记为丢弃。` };
  }

  if (action === "edit") {
    const feedback = note ? `[${nowStamp()}] ${note}` : `[${nowStamp()}] 用户要求修订`;
    const existing = card.feedback ?? [];
    store.updateCard(card.id, { status: "reviewing", feedback: [...existing, feedback] });
    store.audit({ actor, action: "settle-edit", target: card.id, ok: true, note });
    return {
      ok: true,
      status: "reviewing",
      message: `已记录修订意见。请在 Obsidian 中修改暂存文件（${card.stagingPath}），完成后运行 /retro review ${card.id} keep。`
    };
  }

  // 默认按 keep 确认落库。
  if (!card.stagingPath) throw new Error(`卡片 ${card.id} 没有暂存文件`);
  const stagedText = readStaging(cfg, card.stagingPath);
  const parsed = splitCardFile(stagedText);
  const userBody = stripQuestionsSection(parsed.body);

  const vars = {
    title: cleanTitle(parsed.title || card.title || "未命名复盘"),
    createDate: card.createdAt.slice(0, 16).replace("T", " "),
    modifyDate: nowStamp()
  };
  const warnings = [];
  vars._warnings = warnings;
  const template = renderCardTemplate(cfg, "experience", vars);
  const finalText = mergeIntoTemplate(template, vars.title, userBody);

  const settleDir = resolveSettleDir(cfg, dir);
  const settleAbs = safeJoin(cfg.vaultPath, settleDir);
  const fileName = uniqueFileName(settleAbs, `${stampNow()}-${slugify(cleanTitle(vars.title))}`);
  const finalRel = `${settleDir}/${fileName}`;
  const finalTarget = path.join(settleAbs, fileName);
  mkdirSync(path.dirname(finalTarget), { recursive: true });
  atomicWrite(finalTarget, finalText);
  store.updateCard(card.id, { status: "approved", vaultNote: finalRel, updatedAt: new Date().toISOString() });
  store.audit({ actor, action: "settle-keep", target: card.id, ok: true, note: finalRel });

  const warnText = warnings.length > 0 ? `\n⚠️ ${warnings.join("；")}` : "";
  return {
    ok: true,
    status: "approved",
    message: `已落库：${finalRel}\n（暂存文件保留在 ${card.stagingPath}，可随时删除）${warnText}`
  };
}

/** 移除分隔线后的“待确认问题”审阅章节。 */
export function stripQuestionsSection(body) {
  const lines = body.split(/\r?\n/);
  let separatorIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^---\s*$/.test(lines[i])) continue;
    // 标题可能紧跟分隔线，也可能与分隔线之间留有空行。
    const next = lines.slice(i + 1, i + 3).join(" ");
    if (next.includes("待确认问题")) {
      separatorIndex = i;
      break;
    }
  }
  return separatorIndex >= 0 ? lines.slice(0, separatorIndex).join("\n").trim() : body.trim();
}

/** 将 Markdown 拆分为前导内容与各二级标题章节。 */
function splitSections(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = { heading: null, content: [] };
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      sections.push(current);
      current = { heading: m[1].trim(), content: [] };
    } else {
      current.content.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * 合并卡片正文与用户模板：保留模板前导内容与标题，
 * 同名章节优先采用卡片的非空内容，再追加模板中没有的章节。
 */
export function mergeIntoTemplate(template, title, cardBody) {
  const sections = splitSections(template);
  const bodySections = splitSections(cardBody);
  const byHeading = new Map();
  for (const s of bodySections) {
    if (s.heading) byHeading.set(normalizeHeading(s.heading), s);
  }

  const out = [];
  let first = true;
  const safeTitle = cleanTitle(title);
  for (const section of sections) {
    if (section.heading === null) {
      // 替换前导内容中的标题占位符，保留其余内容。
      const preamble = section.content.join("\n").replaceAll("{{title}}", safeTitle).trimEnd();
      if (first) {
        out.push(preamble);
        out.push("");
        out.push(`# ${safeTitle}`);
        out.push("");
        first = false;
      } else {
        out.push(preamble);
      }
      continue;
    }
    const match = byHeading.get(normalizeHeading(section.heading));
    const content = match && match.content.join("\n").trim();
    out.push(`## ${section.heading}`);
    out.push("");
    out.push(content && content.length > 0 ? content : "");
    out.push("");
  }
  // 追加卡片中独有的章节。
  for (const s of bodySections) {
    if (!s.heading) continue;
    const known = sections.some((t) => t.heading && normalizeHeading(t.heading) === normalizeHeading(s.heading));
    if (!known) {
      out.push(`## ${s.heading}`);
      out.push("");
      out.push(s.content.join("\n").trim());
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function normalizeHeading(heading) {
  return String(heading).replace(/[#\d.\s:：\-—()（）【】\[\]]/g, "").toLowerCase();
}

/**
 * 按章节从用户审阅后的卡片提取经验条目字段：
 * 项目目标 → use；关键经验 → model；关键过程 → example；踩坑与根因 → pitfalls；参考链接 → links。
 * 纯文本转换；缺少章节时返回空字符串或空列表。
 */
export function extractEntryFromCard(body) {
  const sections = splitSections(String(body ?? ""));
  const find = (keywords) =>
    sections.find((s) => s.heading && keywords.some((k) => normalizeHeading(s.heading).includes(k)));
  const text = (s) => (s ? s.content.join("\n").trim() : "");
  const items = (s) =>
    s
      ? s.content
          .map((l) => l.replace(/^[-*]\s+/, "").trim())
          .filter(Boolean)
          .slice(0, 12)
      : [];

  const use = clip(text(find(["项目目标", "projectgoal", "project-goal"])), 300);
  const model = clip(text(find(["关键经验", "keytakeaways"])), 600);
  const example = clip(text(find(["关键过程", "process", "architecture", "逻辑"])), 600);
  const pitfalls = items(find(["踩坑", "pitfall", "debug"]));
  const links = items(find(["参考链接", "links", "resource", "参考"])).filter((l) => /^https?:\/\//.test(l) || l.startsWith("[["));
  return { use, model, example, pitfalls, links };
}

/** 移除 frontmatter 后，将卡片文件拆分为 title 与 body。 */
export function splitCardFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { title: null, body: text };
  const title = /^#\s+(.+)$/m.exec(m[2])?.[1]?.trim() ?? null;
  return { title, body: m[2].trim() };
}

/** 在配置的条目暂存区创建永久笔记格式的经验草稿。 */
export function draftEntryFile(cfg, store, entry, { actor = "command" } = {}) {
  const warnings = [];
  const safeTitle = cleanTitle(entry.title || "未命名经验");
  const vars = { title: safeTitle, createDate: nowStamp(), modifyDate: nowStamp() };
  vars._warnings = warnings;
  const template = renderCardTemplate(cfg, "permanent", vars);
  const body = [
    `# ${safeTitle}`,
    "",
    "## Use",
    entry.use ?? "",
    "",
    "## Model",
    entry.model ?? "",
    "",
    "## Example",
    entry.example ?? "",
    "",
    "## Pitfalls",
    ...(entry.pitfalls ?? []).map((p) => `- ${p}`),
    "",
    "## Links",
    ...(entry.links ?? []).map((l) => `- ${l}`),
    ""
  ].join("\n");
  // 移除模板自带的一级标题，仅保留经验条目的实际标题。
  const templateWithoutHeading = template.replace(/^#\s+.+$/m, "").trimEnd();
  const content = `${templateWithoutHeading}\n\n${body}`;
  const fileName = uniqueFileName(entriesRoot(cfg), `${stampNow()}-${slugify(safeTitle)}`);
  const relPath = `_entries/${fileName}`;
  const target = writeStaging(cfg, relPath, content, { store, actor });
  store.updateEntry(entry.id, { draftPath: relPath, status: "drafted" });
  return { relPath, target, warnings };
}

/** 确认经验条目后，将永久笔记写入 experienceRoot。 */
export function settleEntry(cfg, store, entry, { actor = "command" } = {}) {
  const safeTitle = cleanTitle(entry.title || "未命名经验");
  const text = entry.draftPath ? readStaging(cfg, entry.draftPath) : `# ${safeTitle}\n\n${entry.model ?? ""}`;
  const root = experienceRoot(cfg);
  const fileName = uniqueFileName(root, `${stampNow()}-${slugify(safeTitle)}`);
  const finalRel = `${path.relative(cfg.vaultPath, root).split(path.sep).join("/")}/${fileName}`;
  const finalTarget = path.join(root, fileName);
  mkdirSync(path.dirname(finalTarget), { recursive: true });
  atomicWrite(finalTarget, text);
  store.updateEntry(entry.id, { status: "approved", notePath: finalRel, updatedAt: new Date().toISOString() });
  store.audit({ actor, action: "entry-keep", target: entry.id, ok: true, note: finalRel });
  return { ok: true, path: finalRel };
}

/** 仅从只读白名单允许的知识库目录读取笔记。 */
export function readVaultNote(cfg, relPath) {
  requireVault(cfg);
  const whitelist = cfg.readWhitelist ?? [];
  const target = safeJoin(cfg.vaultPath, relPath);
  const allowed = whitelist.some((dir) => {
    const root = safeJoin(cfg.vaultPath, dir);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    try {
      safeJoin(root, relative);
      return true;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new Error(`路径 "${relPath}" 不在只读白名单（${whitelist.join(", ")}）中`);
  }
  const text = readOptional(target);
  if (text === undefined) throw new Error(`笔记不存在：${relPath}`);
  return text;
}
