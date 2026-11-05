// 验证并发锁、内容哈希、写前备份与笔记读取范围；全部使用临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeContentHash, createBackupSnapshot, verifyNoteScope, withStoreLock, RetroError } from "../lib/guard.js";

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("内容哈希稳定且取前 16 位", () => {
  const a = computeContentHash("同一份内容");
  const b = computeContentHash("同一份内容");
  const c = computeContentHash("另一份内容");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("写前备份只在目标存在时生成 .bak", (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, "note.md");
  assert.equal(createBackupSnapshot(target), null);
  writeFileSync(target, "原始内容", "utf8");
  const backup = createBackupSnapshot(target);
  assert.equal(backup, `${target}.bak`);
  assert.equal(readFileSync(backup, "utf8"), "原始内容");
});

test("笔记读取默认只允许 Index/06_Retro/ 作用域", (t) => {
  const dir = tempDir(t);
  const vault = path.join(dir, "vault");
  mkdirSync(path.join(vault, "Index", "06_Retro"), { recursive: true });
  mkdirSync(path.join(vault, "Index", "03_Full_Notes"), { recursive: true });
  const cfg = { vaultPath: vault, security: { exposeVaultNotes: false } };
  assert.ok(verifyNoteScope(cfg, "Index/06_Retro/_retro/a.md"));
  assert.throws(
    () => verifyNoteScope(cfg, "Index/03_Full_Notes/b.md"),
    (error) => error instanceof RetroError && error.code === "RETRO_NOTE_SCOPE_DENIED"
  );
  assert.throws(
    () => verifyNoteScope(cfg, "../../etc/passwd"),
    (error) => error instanceof RetroError && error.code === "RETRO_PATH_OUT_OF_BOUNDS"
  );
  assert.throws(
    () => verifyNoteScope(cfg, ".obsidian/workspace.json"),
    (error) => error instanceof RetroError && error.code === "RETRO_PATH_OUT_OF_BOUNDS"
  );
  // 显式开启后才允许读取其他目录
  assert.ok(verifyNoteScope({ ...cfg, security: { exposeVaultNotes: true } }, "Index/03_Full_Notes/b.md"));
});

test("同一进程内的写入被严格串行化", async (t) => {
  const dir = tempDir(t);
  let counter = 0;
  const tasks = Array.from({ length: 20 }, () => withStoreLock(dir, async () => {
    const current = counter;
    await new Promise((resolve) => setTimeout(resolve, 1));
    counter = current + 1;
  }));
  await Promise.all(tasks);
  assert.equal(counter, 20);
  assert.equal(existsSync(path.join(dir, "store.lock")), false, "锁文件应在任务结束后删除");
});

test("持有者进程已退出的僵死锁会被回收", async (t) => {
  const dir = tempDir(t);
  // 999999 几乎不可能是存活进程，process.kill 会抛 ESRCH。
  writeFileSync(path.join(dir, "store.lock"), JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), "utf8");
  const result = await withStoreLock(dir, async () => "ok");
  assert.equal(result, "ok");
});

test("存活进程持锁且未超时时返回 RETRO_LOCK_BUSY", async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "store.lock"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
  await assert.rejects(
    () => withStoreLock(dir, async () => "never", { timeoutMs: 200, staleMs: 60000 }),
    (error) => error instanceof RetroError && error.code === "RETRO_LOCK_BUSY" && error.status === 423
  );
  rmSync(path.join(dir, "store.lock"), { force: true });
});
