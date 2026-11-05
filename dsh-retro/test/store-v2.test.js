// 验证 store v2 的幂等迁移、v1 备份与 rev 版本号推进；全部使用临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RetroStore, SCHEMA_VERSION, migrateStoreData } from "../lib/store.js";

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-store-v2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeV1Store(dir) {
  const v1 = {
    version: 1,
    materials: [{ id: "mat-1", kind: "feedback", summary: "旧素材", ts: 1 }],
    cards: [{ id: "rc-1", title: "旧卡片", status: "approved", sessionIds: [] }],
    entries: [],
    publish: [],
    audit: [{ ts: 1, actor: "legacy", action: "x", target: "y", ok: true }],
    proposals: [],
    meta: { lastWeeklyCheck: null, weeklyCount: 3 }
  };
  const file = path.join(dir, "store.json");
  writeFileSync(file, JSON.stringify(v1, null, 2), "utf8");
  return { v1, file };
}

test("v1 状态文件启动时升级为 v2，并生成 store.v1.bak.json", (t) => {
  const dir = tempDir(t);
  const { v1, file } = writeV1Store(dir);
  const store = new RetroStore(dir);
  assert.equal(store.data.meta.schemaVersion, SCHEMA_VERSION);
  assert.ok(Number.isSafeInteger(store.data.meta.rev) && store.data.meta.rev > 0);
  // 既有字段与记录数量必须原样保留
  assert.deepEqual(store.data.materials, v1.materials);
  assert.deepEqual(store.data.cards, v1.cards);
  assert.equal(store.data.meta.weeklyCount, 3);
  const backup = path.join(dir, "store.v1.bak.json");
  assert.ok(existsSync(backup), "缺少 v1 备份");
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), v1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).meta.schemaVersion, SCHEMA_VERSION);
});

test("二次启动不重复迁移，也不覆盖最早的 v1 备份", (t) => {
  const dir = tempDir(t);
  const { v1 } = writeV1Store(dir);
  new RetroStore(dir);
  const backupPath = path.join(dir, "store.v1.bak.json");
  const firstBackup = readFileSync(backupPath, "utf8");
  // 改动 v1 备份的时间戳无意义；这里验证再次构造不会重写备份内容
  const again = new RetroStore(dir);
  assert.equal(again.migrated, false);
  assert.equal(readFileSync(backupPath, "utf8"), firstBackup);
  assert.deepEqual(JSON.parse(firstBackup), v1);
});

test("每次写操作推进 rev，且 rev 单调递增", (t) => {
  const dir = tempDir(t);
  const store = new RetroStore(dir);
  const before = store.getRev();
  store.addMaterial({ kind: "manual-capture", summary: "第一条" });
  const afterOne = store.getRev();
  store.audit({ actor: "test", action: "noop", target: "x" });
  const afterTwo = store.getRev();
  assert.ok(afterOne > before, "首次写入应推进 rev");
  assert.ok(afterTwo > afterOne, "rev 必须单调递增");
});

test("迁移函数对已是 v2 的数据保持幂等", () => {
  const v2 = { meta: { schemaVersion: SCHEMA_VERSION, rev: 42 }, cards: [], materials: [], entries: [], publish: [], audit: [], proposals: [] };
  const { data, migrated } = migrateStoreData(v2);
  assert.equal(migrated, false);
  assert.equal(data.meta.rev, 42);
});

test("损坏的 store.json 不影响启动，且保留错误信息", (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "store.json"), "{ not json", "utf8");
  const store = new RetroStore(dir);
  assert.equal(store.data.cards.length, 0);
  assert.ok(String(store.data.lastError ?? "").length > 0);
});
