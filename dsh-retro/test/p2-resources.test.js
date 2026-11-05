// P2 资源列表与博客预检测试：素材流、周报、经验库、博客列表与发布前检查。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../lib/config.js";
import { ensureDirs } from "../lib/settler.js";
import { RetroStore } from "../lib/store.js";
import { createQueryService } from "../lib/query.js";

function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-p2-"));
  const vault = path.join(dir, "vault");
  const blog = path.join(dir, "blog");
  mkdirSync(vault, { recursive: true });
  mkdirSync(path.join(blog, "src", "content", "posts"), { recursive: true });
  const cfg = { ...DEFAULTS, vaultPath: vault, blogPath: blog };
  const store = new RetroStore(path.join(dir, "state"));
  ensureDirs(cfg);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, vault, blog, cfg, store, service: createQueryService({ store, cfg }) };
}

test("资源列表：素材流按类型过滤", (t) => {
  const { store, service } = harness(t);
  store.addMaterial({ sessionId: "s1", kind: "goal-complete", summary: "目标完成 A", importance: 3 });
  store.addMaterial({ sessionId: "s1", kind: "feedback", summary: "反馈 B", importance: 1 });
  const page = service.getSnapshot({ resource: "materials" }).page;
  assert.equal(page.resource, "materials");
  assert.equal(page.items.length, 2);
  const filtered = service.getSnapshot({ resource: "materials", kind: "feedback" }).page;
  assert.deepEqual(filtered.items.map((item) => item.summary), ["反馈 B"]);
});

test("资源列表：周报与经验库来自既有状态", (t) => {
  const { store, service } = harness(t);
  store.addCard({ title: "本周复盘汇总", status: "drafted", source: "weekly" });
  store.addCard({ title: "普通卡片", status: "drafted", source: "session" });
  store.addEntry({ title: "经验 A", status: "approved" });

  const weekly = service.getSnapshot({ resource: "weekly" }).page;
  assert.equal(weekly.items.length, 1);
  assert.equal(weekly.items[0].title, "本周复盘汇总");

  const entries = service.getSnapshot({ resource: "entries" }).page;
  assert.equal(entries.items.length, 1);
  assert.equal(entries.items[0].status, "approved");
});

test("未知资源类型返回 400", (t) => {
  const { service } = harness(t);
  assert.throws(
    () => service.getSnapshot({ resource: "unknown" }),
    (error) => error.code === "RETRO_BAD_REQUEST"
  );
});

test("博客列表与详情预检：draft 标记与缺失图片", (t) => {
  const { blog, service } = harness(t);
  const posts = path.join(blog, "src", "content", "posts");
  writeFileSync(path.join(posts, "exist.png"), "x", "utf8");
  writeFileSync(path.join(posts, "draft-post.md"), [
    "---",
    "title: 草稿文章",
    "published: 2026-11-05",
    "draft: true",
    "tags: [retro]",
    "---",
    "",
    "正文",
    "![本地图片](./exist.png)",
    "![缺失图片](./missing.png)",
    ""
  ].join("\n"), "utf8");

  const page = service.getSnapshot({ resource: "blog" }).page;
  assert.equal(page.resource, "blog");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "draft-post");
  assert.equal(page.items[0].draft, true);

  const detail = service.getEntityDetail({ type: "blog", id: "draft-post" });
  assert.equal(detail.meta.title, "草稿文章");
  assert.equal(detail.checks.draftFlag, true);
  assert.deepEqual(detail.checks.missingImages, ["./missing.png"]);
  assert.equal(detail.checks.ready, false);
  assert.ok(detail.rawMarkdown.includes("正文"));
});

test("博客未配置时给出明确的不可用错误", (t) => {
  const { store } = harness(t);
  const service = createQueryService({ store, cfg: { ...DEFAULTS, vaultPath: "", blogPath: "" } });
  assert.throws(
    () => service.getSnapshot({ resource: "blog" }),
    (error) => error.code === "RETRO_BLOG_UNAVAILABLE"
  );
});
