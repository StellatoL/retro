// dsh-retro: publisher — Obsidian ⇄ Astro Blog (bidirectional).
// Verified against the user's Astro blog: src/content/config.ts posts schema:
//   title/published (required), updated?, draft? (default false), description?, image?, tags[]?, category?, lang?
// Verified: content-utils.ts filters `draft !== true` in PROD → drafts never deploy.
// The public base URL comes from cfg.blogBaseUrl (no hardcoded personal URLs).
import path from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite, isoDate, nowStamp, parseFrontmatter, readOptional, renderFrontmatter, safeJoin, shortId, slugify } from "./util.js";
import { readStaging, readVaultNote, writeStaging } from "./settler.js";

const execFileAsync = promisify(execFile);

function postsDir(cfg) {
  return path.join(cfg.blogPath, "src", "content", "posts");
}

/** List blog posts: [{ slug, title, published, draft, description, tags, category, file }]. */
export function listBlogPosts(cfg) {
  const dir = postsDir(cfg);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return { ok: false, error: `blog posts 目录不存在：${dir}` };
  }
  const posts = [];
  for (const file of files) {
    const text = readOptional(path.join(dir, file));
    if (text === undefined) continue;
    const { data } = parseFrontmatter(text);
    posts.push({
      slug: file.replace(/\.md$/, ""),
      title: data.title ?? file,
      published: data.published ?? null,
      draft: data.draft ?? false,
      description: data.description ?? "",
      tags: data.tags ?? [],
      category: data.category ?? "",
      file
    });
  }
  posts.sort((a, b) => String(a.published).localeCompare(String(b.published)));
  return { ok: true, posts };
}

/** Unique slug for a new post (appends a counter when the file exists). */
function uniqueSlug(cfg, base) {
  const dir = postsDir(cfg);
  let slug = base;
  let n = 2;
  while (readOptional(path.join(dir, `${slug}.md`)) !== undefined) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

/**
 * Obsidian → Blog: create a draft post (draft: true).
 */
export function draftBlogPost(cfg, store, { title, content, description = "", tags = [], category = "", actor = "command" }) {
  const dir = postsDir(cfg);
  mkdirSync(dir, { recursive: true });
  const slug = uniqueSlug(cfg, slugify(title) || `post-${shortId()}`);
  const frontmatter = renderFrontmatter([
    ["title", title],
    ["published", isoDate()],
    ["draft", true],
    ["description", description],
    ["tags", tags],
    ["category", category]
  ]);
  const text = `${frontmatter}\n\n${content.trim()}\n`;
  const file = `${slug}.md`;
  atomicWrite(path.join(dir, file), text);
  store.addPublish({ slug, title, status: "drafted", sourceNote: null, createdAt: nowStamp() });
  store.audit({ actor, action: "blog-draft", target: `posts/${file}`, ok: true });
  return { ok: true, slug, file, path: `src/content/posts/${file}`, draft: true };
}

/** Blog draft from a vault note path (whitelisted read) or a retro card. */
export function draftBlogFromNote(cfg, store, { notePath, card, actor = "command" }) {
  let title;
  let content;
  if (card) {
    title = card.title || "未命名";
    content = card.stagingPath ? readStaging(cfg, card.stagingPath) : (card.fields?.markdown ?? "");
  } else if (notePath) {
    const text = readVaultNote(cfg, notePath);
    const { data, body } = parseFrontmatter(text);
    title = data.title ?? path.basename(notePath, path.extname(notePath));
    content = body.trim() ? body : text;
  } else {
    throw new Error("需要提供 notePath 或 card 参数");
  }
  const result = draftBlogPost(cfg, store, {
    title,
    content,
    description: String(content).slice(0, 120).replace(/\s+/g, " "),
    tags: [],
    category: "",
    actor
  });
  return { ...result, title };
}

/** Draft → publish: set draft:false and git commit (+ optional push). */
export async function publishBlogPost(cfg, store, { slug, push = cfg.blogAutoPush, actor = "command" }) {
  const file = path.join(postsDir(cfg), `${slug}.md`);
  const text = readOptional(file);
  if (text === undefined) return { ok: false, error: `文章不存在：${slug}` };
  const { data, body } = parseFrontmatter(text);
  if (data.draft !== true) return { ok: false, error: `文章 ${slug} 不是草稿（draft 已为 false）` };
  const frontmatter = renderFrontmatter([
    ["title", data.title ?? slug],
    ["published", data.published ?? isoDate()],
    ["draft", false],
    ...(data.description ? [["description", data.description]] : []),
    ...(Array.isArray(data.tags) && data.tags.length > 0 ? [["tags", data.tags]] : []),
    ...(data.category ? [["category", data.category]] : [])
  ]);
  atomicWrite(file, `${frontmatter}\n\n${body.trim()}\n`);

  const rel = `src/content/posts/${slug}.md`;
  try {
    await runGit(cfg, ["add", "--", rel]);
    await runGit(cfg, ["commit", "-m", `publish: ${slug}`, "--", rel]);
    if (push) await runGit(cfg, ["push"]);
  } catch (error) {
    return {
      ok: false,
      error: `git 操作失败：${String(error?.message ?? error)}\n文件已更新为 draft:false，请在 ${cfg.blogPath} 手动提交：git add -A && git commit -m "publish ${slug}"${push ? " && git push" : ""}`
    };
  }
  store.updatePublish(slug, { status: "published", publishedAt: nowStamp() });
  store.audit({ actor, action: "blog-publish", target: rel, ok: true, note: push ? "git push" : "已提交未推送" });
  const base = cfg.blogBaseUrl ?? "";
  return { ok: true, slug, committed: true, pushed: push, blogUrl: base ? `${base}/${slug}/` : null };
}

/** Blog → Obsidian: capture published (or all) posts as permanent-note drafts in staging/_entries. */
export function captureBlogPosts(cfg, store, { scope = "published", actor = "command" } = {}) {
  const listing = listBlogPosts(cfg);
  if (!listing.ok) return listing;
  const targets = listing.posts.filter((p) => scope === "all" || p.draft === false);
  const created = [];
  const base = cfg.blogBaseUrl ?? "";
  for (const post of targets) {
    const existing = store.listEntries().find((e) => e.source === "blog" && e.sourceSlug === post.slug);
    if (existing) continue;
    const entry = store.addEntry({
      title: post.title,
      use: "",
      model: "",
      example: "",
      pitfalls: [],
      links: [base ? `${base}/${post.slug}/` : `（blogBaseUrl 未配置）${post.slug}`],
      tags: post.tags ?? [],
      source: "blog",
      sourceSlug: post.slug,
      status: "drafted",
      description: post.description
    });
    const body = [
      `# ${post.title}`,
      "",
      "## Use",
      post.description ?? "",
      "",
      "## Model",
      "",
      "## Example",
      "",
      "## Pitfalls",
      "",
      "## Links",
      `- ${base ? `${base}/${post.slug}/` : `（blogBaseUrl 未配置）${post.slug}`}`
    ].join("\n");
    const relPath = `_entries/${entry.id}.md`;
    writeStaging(cfg, relPath, body, { store, actor });
    store.updateEntry(entry.id, { draftPath: relPath });
    created.push({ id: entry.id, slug: post.slug, title: post.title });
  }
  store.audit({ actor, action: "blog-capture", target: `posts(${scope})`, ok: true, note: `created ${created.length}` });
  return { ok: true, created, skipped: targets.length - created.length };
}

// Git runner seam: replaceable in tests via setGitRunnerForTest (avoids
// spawning real git in sandboxed/unit environments).
let gitRunner = async (cfg, args) => {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd: cfg.blogPath });
  return (stdout || stderr).trim();
};

/** Test-only seam: swap the git runner (returns the previous runner). */
export function setGitRunnerForTest(runner) {
  const previous = gitRunner;
  if (runner === null) gitRunner = async (cfg, args) => {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: cfg.blogPath });
    return (stdout || stderr).trim();
  };
  else gitRunner = runner;
  return previous;
}

async function runGit(cfg, args) {
  return gitRunner(cfg, args);
}
