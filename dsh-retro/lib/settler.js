// dsh-retro: settler — staging writes (whitelisted), template rendering,
// and the human-confirmed settle/discard flow. Host-side node:fs only.
import path from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWrite, loadTemplate, renderTemplater, safeJoin, fallbackTemplate, nowStamp, shortId, readOptional } from "./util.js";

/** Absolute staging dir (vault/stagingDir). */
export function stagingRoot(cfg) {
  return path.join(cfg.vaultPath, cfg.stagingDir);
}

/** Absolute experience root (vault/experienceRoot). */
export function experienceRoot(cfg) {
  return path.join(cfg.vaultPath, cfg.experienceRoot);
}

/** Absolute proposals dir (vault/proposalsDir). */
export function proposalsRoot(cfg) {
  return path.join(cfg.vaultPath, cfg.proposalsDir ?? "Index/06_Retro/_proposals");
}

/** Absolute entries dir (vault/entriesDir). */
export function entriesRoot(cfg) {
  return path.join(cfg.vaultPath, cfg.entriesDir ?? "Index/06_Retro/_entries");
}

/** Fail loudly when no vault is configured (never fall back to cwd-relative writes). */
function requireVault(cfg) {
  if (!cfg.vaultPath) throw new Error("vaultPath 未配置：运行 /retro config vaultPath <路径> 或设置环境变量 DSH_RETRO_VAULT");
}

/**
 * Route a plugin-owned relative path to its root: `_entries/…` → entriesRoot,
 * `_proposals/…` → proposalsRoot, everything else → stagingRoot.
 */
export function ownedRootFor(cfg, relPath) {
  if (relPath.startsWith("_entries/")) return entriesRoot(cfg);
  if (relPath.startsWith("_proposals/")) return proposalsRoot(cfg);
  return stagingRoot(cfg);
}

/** Ensure all plugin-owned vault dirs exist (host-side mkdir). */
export function ensureDirs(cfg) {
  if (!cfg.vaultPath) return;
  mkdirSync(stagingRoot(cfg), { recursive: true });
  mkdirSync(proposalsRoot(cfg), { recursive: true });
  mkdirSync(entriesRoot(cfg), { recursive: true });
  mkdirSync(experienceRoot(cfg), { recursive: true });
}

/**
 * Write a file under a plugin-owned root (staging/proposals/entries).
 * THE ONLY automatic write target: rejects any path that escapes its root,
 * or touches .obsidian/.git/.trash.
 */
export function writeStaging(cfg, relPath, content, { store, actor = "retro" } = {}) {
  requireVault(cfg);
  const root = ownedRootFor(cfg, relPath);
  const target = safeJoin(root, relPath.replace(/^_entries\/|^_proposals\//, ""));
  atomicWrite(target, content);
  store?.audit({ actor, action: "write-staging", target: relPath, ok: true });
  return target;
}

/** Read a file under a plugin-owned root (same whitelist). */
export function readStaging(cfg, relPath) {
  requireVault(cfg);
  const root = ownedRootFor(cfg, relPath);
  const target = safeJoin(root, relPath.replace(/^_entries\/|^_proposals\//, ""));
  const text = readOptional(target);
  if (text === undefined) throw new Error(`暂存文件不存在：${relPath}`);
  return text;
}

/** Render one of the user's vault templates (or built-in fallback) with Templater materialized. */
export function renderCardTemplate(cfg, kind, vars) {
  const template = loadTemplate(cfg, kind, fallbackTemplate(kind));
  const { text, warnings } = renderTemplater(template, vars);
  if (warnings.length > 0 && typeof vars._warnings === "object") {
    vars._warnings.push(...warnings.map((w) => `模板中存在未渲染的 Templater 表达式：${w.slice(0, 60)}`));
  }
  return text;
}

/** Replace the "{{title}}" placeholder with the concrete title. */
function fillTitle(text, title) {
  return text.replaceAll("{{title}}", title ?? "未命名复盘");
}

/**
 * Materialize a drafted retro card into the staging dir as ONE reviewable file:
 * rendered template + distilled markdown + "待确认问题" section.
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
  const relPath = `${card.id}.md`;
  const target = writeStaging(cfg, relPath, content, { store, actor });
  store.updateCard(card.id, { stagingPath: relPath, status: "drafted" });
  return { relPath, target, warnings };
}

/** Valid final directories for settled notes (relative to vault). */
function resolveSettleDir(cfg, dir) {
  const allowed = cfg.settleDirs ?? ["03_Full_Notes", "04_Projects"];
  const candidate = dir ?? allowed[0];
  if (!allowed.includes(candidate)) {
    throw new Error(`目标目录 "${candidate}" 不在允许列表 ${allowed.join(" / ")} 中（--dir 只能选这些）`);
  }
  return candidate;
}

/**
 * Human-confirmed settle: read the (possibly user-edited) staging file,
 * render the final note into the chosen formal directory, update the store.
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
      message: `已记录修订意见。请在 Obsidian 中修改暂存文件（${card.stagingPath}），或让我重新生成：/retro draft session:${card.sessionIds?.[0] ?? "?"}`
    };
  }

  // keep (default)
  if (!card.stagingPath) throw new Error(`卡片 ${card.id} 没有暂存文件`);
  const stagedText = readStaging(cfg, card.stagingPath);
  const parsed = splitCardFile(stagedText);
  const userBody = stripQuestionsSection(parsed.body);

  const vars = {
    title: parsed.title || card.title || "未命名复盘",
    createDate: card.createdAt.slice(0, 16).replace("T", " "),
    modifyDate: nowStamp()
  };
  const warnings = [];
  vars._warnings = warnings;
  const template = renderCardTemplate(cfg, "experience", vars);
  const finalText = mergeIntoTemplate(template, vars.title, userBody);

  const settleDir = resolveSettleDir(cfg, dir);
  const fileName = `${sanitizeFileName(vars.title)}.md`;
  const finalRel = `${settleDir}/${fileName}`;
  const finalTarget = safeJoin(cfg.vaultPath, finalRel);
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

/** Strip the "待确认问题" review section (everything after the separator `---`). */
export function stripQuestionsSection(body) {
  const lines = body.split(/\r?\n/);
  let separatorIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^---\s*$/.test(lines[i])) continue;
    // The heading may follow the separator directly or after a blank line.
    const next = lines.slice(i + 1, i + 3).join(" ");
    if (next.includes("待确认问题")) {
      separatorIndex = i;
      break;
    }
  }
  return separatorIndex >= 0 ? lines.slice(0, separatorIndex).join("\n").trim() : body.trim();
}

/** Split markdown into preamble + level-2 sections. */
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
 * Merge a card body into the user's template: keep the template's preamble
 * (frontmatter + # title), then for each template section use the card's
 * matching section content when non-empty, and append card-only sections.
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
  for (const section of sections) {
    if (section.heading === null) {
      // preamble: materialize the title placeholder, keep the rest
      const preamble = section.content.join("\n").replaceAll("{{title}}", title).trimEnd();
      if (first) {
        out.push(preamble);
        out.push("");
        out.push(`# ${title}`);
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
  // Append card sections that the template doesn't have.
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

/** Split a drafted card file into { title, body } (frontmatter stripped). */
export function splitCardFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { title: null, body: text };
  const title = /^#\s+(.+)$/m.exec(m[2])?.[1]?.trim() ?? null;
  return { title, body: m[2].trim() };
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|#\[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名";
}

/** Create the experience-entry draft (permanent-note style) in staging/_entries. */
export function draftEntryFile(cfg, store, entry, { actor = "command" } = {}) {
  const warnings = [];
  const vars = { title: entry.title, createDate: nowStamp(), modifyDate: nowStamp() };
  vars._warnings = warnings;
  const template = renderCardTemplate(cfg, "permanent", vars);
  const body = [
    `# ${entry.title}`,
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
  // Drop the template's own H1 heading (e.g. "结论一句话") so only the entry title remains.
  const templateWithoutHeading = template.replace(/^#\s+.+$/m, "").trimEnd();
  const content = `${templateWithoutHeading}\n\n${body}`;
  const relPath = `_entries/${entry.id}.md`;
  const target = writeStaging(cfg, relPath, content, { store, actor });
  store.updateEntry(entry.id, { draftPath: relPath, status: "drafted" });
  return { relPath, target, warnings };
}

/** Confirm an experience entry: write the permanent note into experienceRoot. */
export function settleEntry(cfg, store, entry, { actor = "command" } = {}) {
  const text = entry.draftPath ? readStaging(cfg, entry.draftPath) : `# ${entry.title}\n\n${entry.model ?? ""}`;
  const fileName = `${sanitizeFileName(entry.title)}.md`;
  const finalRel = `${path.relative(cfg.vaultPath, experienceRoot(cfg)).split(path.sep).join("/")}/${fileName}`;
  const finalTarget = safeJoin(cfg.vaultPath, finalRel);
  mkdirSync(path.dirname(finalTarget), { recursive: true });
  atomicWrite(finalTarget, text);
  store.updateEntry(entry.id, { status: "approved", notePath: finalRel, updatedAt: new Date().toISOString() });
  store.audit({ actor, action: "entry-keep", target: entry.id, ok: true, note: finalRel });
  return { ok: true, path: finalRel };
}

/** Read a note from the vault (whitelisted dirs only). */
export function readVaultNote(cfg, relPath) {
  const whitelist = cfg.readWhitelist ?? [];
  const top = relPath.split(/[\\/]/)[0];
  if (!whitelist.includes(top)) {
    throw new Error(`路径 "${relPath}" 不在只读白名单（${whitelist.join(", ")}）中`);
  }
  const target = safeJoin(cfg.vaultPath, relPath);
  const text = readOptional(target);
  if (text === undefined) throw new Error(`笔记不存在：${relPath}`);
  return text;
}

export { existsSync, readFileSync, writeFileSync, shortId };
