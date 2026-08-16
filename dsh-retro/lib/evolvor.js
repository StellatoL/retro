// dsh-retro: evolvor — experience library, dedupe suggestions, and
// SKILL.md / AGENTS.md evolution proposals (AI drafts, user adopts).
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { atomicWrite, nowStamp, readOptional, safeJoin } from "./util.js";
import { readStaging, writeStaging } from "./settler.js";
import { listBlogPosts } from "./publisher.js";

function skillsDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "skills", "retro-writing");
}

function globalAgentsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "AGENTS.md");
}

/** Path of the SKILL.md bundled with this package. */
export function bundledSkillPath() {
  return fileURLToPath(new URL("../skills/retro-writing/SKILL.md", import.meta.url));
}

/**
 * First-run: install the bundled retro-writing skill to ~/.dsh/skills
 * if missing. Never overwrites a user-edited skill file.
 */
export function ensureSkillFiles() {
  try {
    const targetDir = skillsDir();
    const target = path.join(targetDir, "SKILL.md");
    if (readOptional(target) !== undefined) return { ok: true, created: false, path: target };
    const source = readOptional(bundledSkillPath());
    if (source === undefined) return { ok: false, error: "bundled SKILL.md not found" };
    mkdirSync(targetDir, { recursive: true });
    atomicWrite(target, source);
    return { ok: true, created: true, path: target };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Propose a skill/AGENTS.md update: writes a proposal file into the staging
 * `_proposals/` dir and records it in the store. Adoption is explicit via
 * `/retro adopt <proposalId>`.
 */
export function proposeUpdate(cfg, store, { kind, title, content, reason, actor = "command" }) {
  const id = `prop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const relPath = `_proposals/${id}.md`;
  const text = [
    "---",
    `Type: dsh_retro_proposal`,
    `kind: ${kind}`,
    `createDate: ${nowStamp()}`,
    "---",
    "",
    `# ${title}`,
    "",
    `> 建议原因：${reason}`,
    "",
    "```markdown",
    content,
    "```",
    "",
    `> 确认方式：运行 \`/retro adopt ${id}\` 应用此提案（原文件自动备份 .bak）。`,
    ""
  ].join("\n");
  writeStaging(cfg, relPath, text, { store, actor });
  store.addProposal({ id, kind, title, reason, relPath, status: "pending" });
  return { ok: true, id, relPath };
}

/**
 * Adopt a pending proposal. For skill updates: backup the current file,
 * then apply the new content. For AGENTS.md: same policy.
 */
export function adoptProposal(cfg, store, proposal, { actor = "command" } = {}) {
  if (proposal.status !== "pending") throw new Error(`提案 ${proposal.id} 状态为 ${proposal.status}，不可重复采纳`);
  const staged = readStaging(cfg, proposal.relPath);
  const m = /```markdown\n([\s\S]*?)\n```/.exec(staged);
  const content = m ? m[1] : staged;

  let target;
  if (proposal.kind === "skill") {
    target = path.join(skillsDir(), "SKILL.md");
  } else if (proposal.kind === "agents") {
    target = globalAgentsPath();
  } else {
    throw new Error(`未知提案类型：${proposal.kind}`);
  }

  const existing = readOptional(target);
  if (existing !== undefined) {
    atomicWrite(`${target}.bak`, existing);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  atomicWrite(target, content);
  store.updateProposal(proposal.id, { status: "adopted", adoptedAt: nowStamp() });
  store.audit({ actor, action: "adopt", target: proposal.id, ok: true, note: target });
  return { ok: true, target, backedUp: existing !== undefined };
}

/** Keyword-overlap dedupe suggestions against the experience library. */
export function dedupeSuggestions(store, { title, takeaways = [] }) {
  const tokens = new Set(
    String(title ?? "")
      .split(/[\s，。、,.\-—:：]+/)
      .filter((t) => t.length >= 2)
  );
  for (const t of takeaways ?? []) {
    for (const tok of String(t).split(/[\s，。、,.\-—:：]+/).filter((x) => x.length >= 2)) tokens.add(tok);
  }
  if (tokens.size === 0) return [];
  const hits = [];
  for (const entry of store.listEntries()) {
    const entryTokens = new Set(
      String(entry.title ?? "").split(/[\s，。、,.\-—:：]+/).filter((t) => t.length >= 2)
    );
    let overlap = 0;
    for (const tok of tokens) if (entryTokens.has(tok)) overlap++;
    if (overlap > 0 && overlap / Math.max(1, entryTokens.size) >= 0.34) {
      hits.push({ entryId: entry.id, title: entry.title, overlap });
    }
  }
  return hits.slice(0, 5);
}

/** Keyword overlap against existing blog posts (draft-time guard). */
export function dedupeBlogPosts(cfg, title) {
  const listing = listBlogPosts(cfg);
  if (!listing.ok) return [];
  const tokens = new Set(String(title ?? "").split(/[\s，。、,.\-—:：]+/).filter((t) => t.length >= 2));
  const hits = [];
  for (const post of listing.posts) {
    const postTokens = new Set(String(post.title ?? "").split(/[\s，。、,.\-—:：]+/).filter((t) => t.length >= 2));
    let overlap = 0;
    for (const tok of tokens) if (postTokens.has(tok)) overlap++;
    if (overlap > 0 && overlap / Math.max(1, postTokens.size) >= 0.5) {
      hits.push({ slug: post.slug, title: post.title, overlap });
    }
  }
  return hits.slice(0, 5);
}
