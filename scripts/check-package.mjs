// 实际打包并在临时目录检验产物，避免仅检查源码而遗漏随包文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "dsh-retro-pack-"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "请通过 npm run test:package 运行");

try {
  const output = execFileSync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", tmp], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(tmp, "npm-cache"), npm_config_update_notifier: "false" }
  });
  const [packed] = JSON.parse(output);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ["package.json", "README.md", "README.zh-CN.md", "LICENSE", "dsh-retro/skills/retro-writing/SKILL.md", ...Object.values(pkg.exports)]) {
    assert.ok(files.has(required.replace(/^\.\//, "")), `分发包缺少 ${required}`);
  }
  for (const file of files) {
    assert.ok(/^(?:package\.json$|README(?:\.zh-CN)?\.md$|LICENSE$|dsh-retro\/(?:lib\/|skills\/|README\.md$|cordis\.patch\.yml$))/.test(file), `分发包含非运行文件：${file}`);
  }
  const archive = path.join(tmp, packed.filename);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  assert.equal(integrity, packed.integrity);
  execFileSync("tar", ["-xzf", archive, "-C", tmp], { stdio: "pipe" });
  const unpacked = path.join(tmp, "package");
  // 仅复用已安装的开发依赖；插件源码和技能必须来自刚解包的 tarball。
  symlinkSync(path.join(root, "node_modules"), path.join(unpacked, "node_modules"), "junction");
  // 模拟 profile 的按包名解析，避免直接导入源码掩盖 exports 或客户端声明错误。
  const profile = path.join(tmp, "profile");
  mkdirSync(path.join(profile, "node_modules"), { recursive: true });
  symlinkSync(unpacked, path.join(profile, "node_modules", pkg.name), "junction");
  const requireFromProfile = createRequire(path.join(profile, "index.js"));
  const installed = JSON.parse(readFileSync(requireFromProfile.resolve("dsh-retro/package.json"), "utf8"));
  assert.deepEqual(installed.dsh.client, { platform: "web", inject: [] });
  const plugin = await import(pathToFileURL(requireFromProfile.resolve("dsh-retro")).href);
  assert.equal(plugin.name, "retro");
  assert.equal(typeof plugin.apply, "function");
  assert.ok(plugin.inject.includes("tools"));
  const { bundledSkillPath } = await import(pathToFileURL(path.join(unpacked, "dsh-retro/lib/evolvor.js")).href);
  assert.ok(existsSync(bundledSkillPath()), "安装后的插件无法定位配套技能");
  assert.ok(path.relative(realpathSync.native(unpacked), realpathSync.native(bundledSkillPath())).startsWith(`dsh-retro${path.sep}`));
  let clientModule;
  const clientFile = requireFromProfile.resolve("dsh-retro/client");
  runInNewContext(readFileSync(clientFile, "utf8"), {
    window: { __ModuleLoader__: { load(definition) { clientModule = definition; } } }
  }, { filename: clientFile });
  assert.equal(clientModule.id, "dsh-retro");
  const client = clientModule.factory((name) => {
    assert.equal(name, "react");
    return {};
  });
  assert.equal(typeof client.apply, "function");
  assert.equal(client.inject.length, 0);
  console.log(`打包检查通过：${packed.filename}，${files.size} 个文件；宿主、客户端与技能均可从安装产物按包名加载。`);
} finally {
  // tmp 由 mkdtemp 创建，删除范围仅限本次检查的临时目录。
  rmSync(tmp, { recursive: true, force: true });
}
