// 显式收集测试文件，统一运行单元测试与两个冒烟脚本，不依赖 shell 通配符。
import { readdirSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../dsh-retro/test/", import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js") || name.endsWith("-smoke.mjs"))
  .sort()
  .map((name) => path.join(dir, name));
const stream = run({ files });
stream.on("test:fail", () => { process.exitCode = 1; });
stream.compose(spec).pipe(process.stdout);
