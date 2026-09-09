// 博客联动：面向 src/content/posts 下的 Markdown 文章。
// 站点内容模型需支持 title、published、draft、description、tags、category 等字段。
// draft: true 是否在生产构建中排除取决于站点实现，插件不控制站点构建。
// 公开链接前缀来自 cfg.blogBaseUrl。
import path from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite, isoDate, nowStamp, parseFrontmatter, readOptional, renderFrontmatter, safeJoin, shortId, slugify } from "./util.js";
import { readStaging, readVaultNote, writeStaging } from "./settler.js";

const execFileAsync = promisify(execFile);

function postsDir(cfg) {
  if (typeof cfg.blogPath !== "string" || !cfg.blogPath.trim()) {
    throw new Error("blogPath 未配置：运行 /retro config blogPath <路径> 或设置环境变量 DSH_RETRO_BLOG");
  }
  return safeJoin(cfg.blogPath, "src/content/posts");
}

/** 列出文章的主题名、标题、发布日期、草稿状态、分类和文件路径等元数据。 */
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

/** 为新文章选择唯一文件名，已占用时追加序号。 */
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
 * 知识库到博客：创建带 draft: true 标记的文章草稿。
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

/** 从只读白名单内的知识库笔记或复盘卡片创建博客草稿。 */
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

/** 将草稿标记改为 false 后提交 Git；仅在显式开启时推送。 */
export async function publishBlogPost(cfg, store, { slug, push = cfg.blogAutoPush, actor = "command" }) {
  const file = safeJoin(postsDir(cfg), `${slug}.md`);
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

/** 博客到知识库：将选定文章抓取为待确认的永久笔记草稿。 */
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

// Git 执行器可在测试中替换，避免测试触发真实提交与推送。
let gitRunner = async (cfg, args) => {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd: cfg.blogPath });
  return (stdout || stderr).trim();
};

/** 测试专用：替换 Git 执行器，并返回原执行器以便恢复。 */
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
