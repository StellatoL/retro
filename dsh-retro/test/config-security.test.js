// 验证分组配置（security.* / storage.*）的点号读写与默认安全值。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, getConfigPath, loadConfig, parseConfigValue, saveConfig } from "../lib/config.js";

function withTempHome(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retro-config-"));
  const previous = process.env.DSH_RETRO_DIR;
  process.env.DSH_RETRO_DIR = path.join(dir, "retro");
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_RETRO_DIR;
    else process.env.DSH_RETRO_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("写接口与笔记预览默认关闭", () => {
  assert.equal(DEFAULTS.security.enableWriteApi, false);
  assert.equal(DEFAULTS.security.exposeVaultNotes, false);
  assert.equal(DEFAULTS.security.requireDoubleConfirm, true);
});

test("点号键可读可写，并落盘为嵌套结构", (t) => {
  withTempHome(t);
  saveConfig({ "security.enableWriteApi": true });
  const cfg = loadConfig();
  assert.equal(cfg.security.enableWriteApi, true);
  // 未改动的同级键保持默认值
  assert.equal(cfg.security.exposeVaultNotes, false);
  assert.equal(getConfigPath(cfg, "security.enableWriteApi"), true);
  assert.equal(getConfigPath(cfg, "security"), cfg.security);
});

test("parseConfigValue 按默认值类型解析点号键", () => {
  assert.equal(parseConfigValue("security.enableWriteApi", "true"), true);
  assert.equal(parseConfigValue("security.exposeVaultNotes", "false"), false);
  assert.equal(parseConfigValue("storage.archiveRetentionDays", "45"), 45);
  assert.throws(() => parseConfigValue("security", "{}"), /分组配置/);
  assert.throws(() => parseConfigValue("security.unknownKey", "true"), /未知配置项/);
});
