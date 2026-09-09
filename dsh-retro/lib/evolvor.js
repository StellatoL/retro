// 进化层：维护经验库与索引，提示重复内容，生成技能或全局规则提案。
// 模型负责草拟，用户通过命令确认采纳。
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync } from "node:fs";
import { atomicWrite, nowStamp, stampNow, uniqueFileName, slugify, cleanTitle, parseFrontmatter, readOptional, safeJoin } from "./util.js";
import { experienceRoot, proposalsRoot, readStaging, writeStaging } from "./settler.js";
import { listBlogPosts } from "./publisher.js";

/** 经验库根目录内的索引文件名。 */
export const MOC_FILENAME = "00_索引.md";

function skillsDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "skills", "retro-writing");
}

function globalAgentsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "AGENTS.md");
}

/** 定位随插件分发的 SKILL.md。 */
export function bundledSkillPath() {
  return fileURLToPath(new URL("../skills/retro-writing/SKILL.md", import.meta.url));
}

/**
 * 首次运行时，将配套 retro-writing 技能安装到 DSH 技能目录。
 * 已存在的技能文件保持原样。
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
 * 将技能或 AGENTS.md 更新建议写到提案目录，并记录到状态存储。
 * 用户通过 /retro adopt <proposalId> 明确采纳后才应用。
 */
export function proposeUpdate(cfg, store, { kind, title, content, reason, actor = "command" }) {
  const id = `prop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const fileName = uniqueFileName(proposalsRoot(cfg), `${stampNow()}-${slugify(cleanTitle(title) || "提案")}`);
  const relPath = `_proposals/${fileName}`;
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
 * 采纳待处理提案：备份已有文件，再追加用户确认的规则片段。
 * 技能文件与 AGENTS.md 使用同一保留原文策略。
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
  // 提案是追加片段，不能用短片段覆盖整个技能或全局规则文件。
  let base = existing ?? (proposal.kind === "skill" ? readOptional(bundledSkillPath()) ?? "" : "");
  if (proposal.kind === "skill" && !/^---\r?\n/.test(base)) {
    base = `---\nname: retro-writing\ndescription: 将会话和项目经历提炼为可审阅的复盘卡片与经验。\n---\n\n${base}`;
  }
  atomicWrite(target, `${base.trimEnd()}${base.trim() ? "\n\n" : ""}${content.trim()}\n`);
  store.updateProposal(proposal.id, { status: "adopted", adoptedAt: nowStamp() });
  store.audit({ actor, action: "adopt", target: proposal.id, ok: true, note: target });
  return { ok: true, target, backedUp: existing !== undefined };
}

/** 按关键词重叠度提示经验库中可能重复的条目。 */
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

/** 创建博客草稿时，按关键词重叠度提示已有相似文章。 */
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

// 提案去重

/** 生成相邻双字符特征集，支持中文并忽略标点和空白。 */
function bigrams(text) {
  const s = String(text ?? "").replace(/[\s，。、,.\-—:：()（）\[\]「」【】]/g, "");
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 根据标题和理由的特征集计算两份提案的 Jaccard 相似度。 */
function proposalSimilarity(a, b) {
  const fa = bigrams((a.title ?? "") + (a.reason ?? ""));
  const fb = bigrams((b.title ?? "") + (b.reason ?? ""));
  if (fa.size === 0 || fb.size === 0) return 0;
  let inter = 0;
  for (const x of fa) if (fb.has(x)) inter++;
  return inter / (fa.size + fb.size - inter);
}

/**
 * 按相邻双字符的 Jaccard 相似度为待采纳提案分组。
 * 返回每组代表与重复项；阈值取值为 0 到 1，属于文本相似度启发式。
 */
export function dedupeProposals(proposals, threshold = 0.3) {
  const list = (proposals ?? []).filter((p) => p && p.status === "pending" && p.kind !== "retro-suggest");
  const groups = [];
  const assigned = new Set();
  for (let i = 0; i < list.length; i++) {
    if (assigned.has(list[i].id)) continue;
    const group = { representative: list[i], duplicates: [] };
    assigned.add(list[i].id);
    for (let j = 0; j < list.length; j++) {
      if (j === i || assigned.has(list[j].id)) continue;
      if (proposalSimilarity(list[i], list[j]) >= threshold) {
        group.duplicates.push(list[j]);
        assigned.add(list[j].id);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * 维护经验库的 00_索引.md：扫描根目录中的笔记，排除索引本身，
 * 重新生成链接列表与使用提示。条目落库后及 /weekly 中调用，支持空库。
 */
export function updateMoc(cfg, store, { actor = "command" } = {}) {
  const root = experienceRoot(cfg);
  mkdirSync(root, { recursive: true });
  const files = readdirSync(root)
    .filter((f) => f.endsWith(".md") && f !== MOC_FILENAME)
    .sort((a, b) => a.localeCompare(b, "zh"));

  const entries = [];
  for (const file of files) {
    const text = readOptional(path.join(root, file)) ?? "";
    const { data } = parseFrontmatter(text);
    const name = file.replace(/\.md$/, "");
    const tags = Array.isArray(data.Tags) ? data.Tags.join(", ") : Array.isArray(data.tags) ? data.tags.join(", ") : "";
    const source = data.Source || "";
    entries.push({ name, tags, source });
  }

  const lines = [
    "---",
    "Type: moc",
    `modifyDate: ${nowStamp()}`,
    `entryCount: ${entries.length}`,
    "---",
    "",
    "# 经验库索引",
    "",
    "> 本索引由 dsh-retro 自动维护（经验条目沉淀或 /weekly 时刷新）。",
    "> 每条经验是原子笔记：Use / Model / Example / Pitfalls / Links。",
    "",
    ...(entries.length === 0
      ? ["（经验库为空：通过 /retro review <id> keep 落库后会自动生成经验条目，再 /retro entry keep <id> 沉淀到这里）"]
      : entries.map((e) => `- [[${e.name}]]${e.tags ? ` — ${e.tags}` : ""}${e.source ? `（来源：${e.source}）` : ""}`))
  ];

  const mocPath = path.join(root, MOC_FILENAME);
  atomicWrite(mocPath, lines.join("\n") + "\n");
  store?.audit({ actor, action: "moc-update", target: `经验库/${MOC_FILENAME}`, ok: true, note: `${entries.length} 条` });
  return { ok: true, path: `经验库/${MOC_FILENAME}`, count: entries.length };
}
