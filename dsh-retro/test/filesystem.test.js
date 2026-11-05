// 验证配置路径、只读白名单与博客路径边界；所有文件均位于临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeJoin } from "../lib/util.js";
import { DEFAULTS } from "../lib/config.js";
import { ensureDirs, readVaultNote, settleEntry, writeStaging } from "../lib/settler.js";
import { draftBlogPost, publishBlogPost } from "../lib/publisher.js";
import { RetroStore } from "../lib/store.js";

function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-paths-"));
  // Windows 上目录链接可能让递归删除报 ENOTEMPTY；清理失败不应覆盖断言结论。
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 临时目录残留不影响测试结果 */
    }
  });
  const vault = path.join(dir, "vault");
  mkdirSync(vault);
  return { dir, vault, cfg: { ...DEFAULTS, vaultPath: vault }, store: new RetroStore(path.join(dir, "state")) };
}

test("路径检查拒绝空根、绝对输入和受保护目录的大小写变体", (t) => {
  const { vault } = harness(t);
  assert.throws(() => safeJoin("", "file.md"));
  assert.throws(() => safeJoin(vault, path.join(vault, "absolute.md")));
  for (const rel of ["C:relative.md", "C:\\absolute.md", "a\\..\\..\\escape.md", ".GIT/config", ".Obsidian/settings.json", ".trash/note.md"]) {
    assert.throws(() => safeJoin(vault, rel), rel);
  }
});

test("配置中的暂存目录不能越出知识库", (t) => {
  const { cfg, dir } = harness(t);
  cfg.stagingDir = "../outside";
  assert.throws(() => ensureDirs(cfg));
  assert.equal(existsSync(path.join(dir, "outside")), false);
});

test("只读白名单使用规范化后的路径判断", (t) => {
  const { cfg, vault } = harness(t);
  mkdirSync(path.join(vault, "Index"));
  writeFileSync(path.join(vault, "private.md"), "白名单外的笔记");
  assert.throws(() => readVaultNote(cfg, "Index/../private.md"), /白名单/);
  writeFileSync(path.join(vault, "Index", "public.md"), "允许读取");
  assert.equal(readVaultNote(cfg, "Index/public.md"), "允许读取");
});

test("暂存区中的目录链接不能将写入导向白名单之外", (t) => {
  const { cfg, vault, dir } = harness(t);
  ensureDirs(cfg);
  const outside = path.join(dir, "outside");
  mkdirSync(outside);
  const link = path.join(vault, cfg.stagingDir, "linked");
  symlinkSync(outside, link, "junction");
  try {
    assert.throws(() => writeStaging(cfg, "linked/file.md", "不应写出"));
    assert.equal(existsSync(path.join(outside, "file.md")), false);
  } finally {
    // 先断开目录链接：rmdir 只删除链接本身，不影响链接目标；残留链接会让递归清理报 ENOTEMPTY。
    try {
      rmdirSync(link);
    } catch {
      rmSync(link, { recursive: true, force: true });
    }
  }
});

test("知识库未配置时，经验条目不能落入当前工作目录", (t) => {
  const { cfg, store, dir } = harness(t);
  cfg.vaultPath = "";
  const previous = process.cwd();
  process.chdir(dir);
  try {
    assert.throws(() => settleEntry(cfg, store, { id: "x", title: "测试" }), /vaultPath/);
  } finally {
    process.chdir(previous);
  }
});

test("博客未配置时拒绝生成草稿", (t) => {
  const { cfg, store, dir } = harness(t);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    assert.throws(() => draftBlogPost(cfg, store, { title: "测试", content: "正文" }), /blogPath/);
  } finally {
    process.chdir(previous);
  }
});

test("发布操作拒绝通过 slug 越出博客文章目录", async (t) => {
  const { cfg, dir, store } = harness(t);
  cfg.blogPath = path.join(dir, "blog");
  mkdirSync(path.join(cfg.blogPath, "src", "content", "posts"), { recursive: true });
  await assert.rejects(publishBlogPost(cfg, store, { slug: "../outside" }), /路径|path/);
});
