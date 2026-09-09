// 博客联动测试：替换 Git 执行器，不触发真实提交或推送。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";

import { listBlogPosts, draftBlogPost, draftBlogFromNote, publishBlogPost, captureBlogPosts, setGitRunnerForTest } from "../lib/publisher.js";
import { RetroStore } from "../lib/store.js";

function tmpEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-pub-"));
  const vault = path.join(dir, "vault");
  const blog = path.join(dir, "blog");
  mkdirSync(vault, { recursive: true });
  mkdirSync(path.join(blog, "src", "content", "posts"), { recursive: true });
  const cfg = {
    vaultPath: vault,
    blogPath: blog,
    blogBaseUrl: "https://example.com",
    stagingDir: "Index/06_Retro/_retro",
    experienceRoot: "Index/06_Retro/经验库",
    proposalsDir: "Index/06_Retro/_proposals",
    entriesDir: "Index/06_Retro/_entries",
    readWhitelist: ["Index"],
    blogAutoPush: false
  };
  return { dir, vault, blog, cfg };
}

afterEach(() => {
  setGitRunnerForTest(null);
});

test("draftBlogPost writes valid frontmatter and unique slug", () => {
  const { dir, blog, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  const r1 = draftBlogPost(cfg, store, { title: "经验：踩坑记录", content: "正文", tags: ["a"], category: "技术" });
  assert.equal(r1.ok, true);
  assert.equal(r1.slug, "经验-踩坑记录"); // 保留中文，标点改为连字符。
  const file = readFileSync(path.join(blog, "src", "content", "posts", `${r1.slug}.md`), "utf8");
  assert.ok(file.includes('title: "经验：踩坑记录"')); // 含全角冒号的标题加引号。
  assert.ok(file.includes("draft: true"));
  assert.ok(file.includes("published: "));
  assert.ok(file.includes("tags:"));
  assert.ok(file.includes("category: 技术"));
  // 同名文章使用 -2 后缀，避免覆盖。
  const r2 = draftBlogPost(cfg, store, { title: "经验：踩坑记录", content: "x" });
  assert.equal(r2.slug, "经验-踩坑记录-2");
  // 状态存储应记录发布队列条目。
  assert.equal(store.getPublish(r1.slug).status, "drafted");
  rmSync(dir, { recursive: true, force: true });
});

test("listBlogPosts parses frontmatter and draft flag", () => {
  const { dir, blog, cfg } = tmpEnv();
  const postsDir = path.join(blog, "src", "content", "posts");
  writeFileSync(path.join(postsDir, "a.md"), "---\ntitle: \"A: 测试\"\npublished: 2026-01-01\ndraft: true\ntags:\n  - x\n---\nbody");
  writeFileSync(path.join(postsDir, "b.md"), "---\ntitle: B\npublished: 2026-02-01\n---\nbody");
  const listing = listBlogPosts(cfg);
  assert.equal(listing.ok, true);
  assert.equal(listing.posts.length, 2);
  const a = listing.posts.find((p) => p.slug === "a");
  assert.equal(a.title, "A: 测试");
  assert.equal(a.draft, true);
  assert.deepEqual(a.tags, ["x"]);
  const b = listing.posts.find((p) => p.slug === "b");
  assert.equal(b.draft, false);
  rmSync(dir, { recursive: true, force: true });
});

test("captureBlogPosts creates entry drafts once", () => {
  const { dir, blog, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  const postsDir = path.join(blog, "src", "content", "posts");
  writeFileSync(path.join(postsDir, "published.md"), "---\ntitle: 已发布\ndraft: false\n---\nbody");
  writeFileSync(path.join(postsDir, "draft.md"), "---\ntitle: 草稿\ndraft: true\n---\nbody");

  const r1 = captureBlogPosts(cfg, store, { scope: "published" });
  assert.equal(r1.ok, true);
  assert.equal(r1.created.length, 1); // 默认只抓取已发布文章。
  const entry = store.listEntries()[0];
  assert.equal(entry.source, "blog");
  assert.equal(entry.sourceSlug, "published");
  assert.ok(entry.links[0].includes("https://example.com/published/"));
  // 条目草稿位于配置的 _entries 目录中。
  assert.ok(readdirSync(path.join(cfg.vaultPath, "Index", "06_Retro", "_entries")).length === 1);

  // 再次抓取不产生重复条目。
  const r2 = captureBlogPosts(cfg, store, { scope: "published" });
  assert.equal(r2.created.length, 0);
  assert.equal(store.listEntries().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("publishBlogPost flips draft, commits and pushes via injected runner", async () => {
  const { dir, blog, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  const r1 = draftBlogPost(cfg, store, { title: "待发布", content: "正文" });
  const calls = [];
  setGitRunnerForTest(async (c, args) => { calls.push(args); return "ok"; });

  const result = await publishBlogPost(cfg, store, { slug: r1.slug, push: true });
  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);
  // 验证 Git 暂存、提交与推送的调用顺序。
  assert.ok(calls.some((a) => a[0] === "add"));
  assert.ok(calls.some((a) => a[0] === "commit" && a.join(" ").includes(r1.slug)));
  assert.ok(calls.some((a) => a[0] === "push"));
  // 文件中的草稿标记应已关闭。
  const text = readFileSync(path.join(blog, "src", "content", "posts", `${r1.slug}.md`), "utf8");
  assert.ok(text.includes("draft: false"));
  assert.equal(store.getPublish(r1.slug).status, "published");
  rmSync(dir, { recursive: true, force: true });
});

test("publishBlogPost refuses non-draft posts", async () => {
  const { dir, blog, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  const r1 = draftBlogPost(cfg, store, { title: "X", content: "x" });
  const calls = [];
  setGitRunnerForTest(async (c, args) => { calls.push(args); return "ok"; });
  await publishBlogPost(cfg, store, { slug: r1.slug, push: false });
  const second = await publishBlogPost(cfg, store, { slug: r1.slug, push: false });
  assert.equal(second.ok, false);
  assert.match(second.error, /不是草稿/);
  assert.equal(calls.filter((a) => a[0] === "commit").length, 1); // 不重复提交。
  rmSync(dir, { recursive: true, force: true });
});

test("draftBlogFromNote reads a whitelisted vault note", () => {
  const { dir, vault, cfg } = tmpEnv();
  const store = new RetroStore(path.join(dir, "state"));
  const noteDir = path.join(vault, "Index", "03_Full_Notes", "04_Retro");
  mkdirSync(noteDir, { recursive: true });
  writeFileSync(path.join(noteDir, "笔记.md"), "---\ntitle: 笔记标题\n---\n正文内容");
  const result = draftBlogFromNote(cfg, store, { notePath: "Index/03_Full_Notes/04_Retro/笔记.md" });
  assert.equal(result.ok, true);
  assert.equal(result.title, "笔记标题");
  assert.ok(result.path.startsWith("src/content/posts/"));
  rmSync(dir, { recursive: true, force: true });
});
