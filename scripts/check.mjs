// 检查分发清单、DSH 入口和源码语法；不启动插件、不读写用户数据。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
const pkg = readJson("package.json");
const legacy = readJson("dsh-retro/package.json");

assert.equal(pkg.name, "dsh-retro");
assert.equal(pkg.private, undefined, "根目录必须可作为正式分发包");
assert.equal(legacy.private, true, "子目录只保留兼容入口");
for (const key of ["name", "version", "type", "engines", "license", "peerDependencies", "peerDependenciesMeta"]) {
  assert.deepEqual(pkg[key], legacy[key], `两份清单的 ${key} 不一致`);
}
assert.deepEqual(pkg.dsh.client, { platform: "web", inject: [] });
assert.deepEqual(pkg.dsh.client, legacy.dsh.client);
assert.ok(pkg.keywords.includes("dsh-plugin"));
for (const key of [".", "./client", "./cordis.patch.yml"]) {
  assert.equal(pkg.exports[key], `./dsh-retro${legacy.exports[key].slice(1)}`);
  assert.ok(existsSync(path.join(root, pkg.exports[key])), `缺少导出文件：${key}`);
}
assert.equal(pkg.dsh.bundle.patch, pkg.exports["./cordis.patch.yml"]);
const patch = loadYaml(readFileSync(path.join(root, pkg.dsh.bundle.patch), "utf8"));
assert.deepEqual(patch, [{ insert: [{ id: "retro", name: "dsh-retro", config: {} }] }]);

const skill = readFileSync(path.join(root, "dsh-retro/skills/retro-writing/SKILL.md"), "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
assert.ok(frontmatter, "配套技能必须包含 DSH frontmatter");
const skillMeta = loadYaml(frontmatter[1]);
assert.equal(skillMeta.name, "retro-writing");
assert.equal(typeof skillMeta.description, "string");
assert.ok(skillMeta.description.trim());

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(?:js|mjs)$/.test(entry.name) ? [file] : [];
  });
}
const files = ["dsh-retro/lib", "dsh-retro/test", "scripts"].flatMap((dir) => sourceFiles(path.join(root, dir)));
for (const file of files) {
  execFileSync(process.execPath, [...process.execArgv, "--check", path.relative(root, file)], { cwd: root, stdio: "pipe" });
}
console.log(`检查通过：DSH 分发清单、兼容入口、技能元数据、${files.length} 个脚本的语法。`);
