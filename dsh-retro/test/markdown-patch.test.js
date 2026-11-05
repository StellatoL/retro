// 验证 Markdown 局部合并：只替换已知小节，用户手写章节必须原样保留。
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchMarkdownSections } from "../lib/util.js";

const SAMPLE = [
  "# 死锁排查复盘",
  "",
  "## 项目目标",
  "",
  "定位高并发下的队列挂起",
  "",
  "## 行动项",
  "",
  "- [ ] 旧行动项",
  "",
  "## 附注图表",
  "",
  "![架构图](assets/arch.png)",
  "这里是用户手写的补充说明",
  "",
  "## 待确认问题",
  "",
  "- 连接池上限是多少？",
  ""
].join("\n");

test("替换行动项正文，同时完整保留用户自定义章节", () => {
  const out = patchMarkdownSections(SAMPLE, { sections: { actions: "- [x] 增加锁超时断言单测" } });
  assert.ok(out.includes("- [x] 增加锁超时断言单测"));
  assert.ok(!out.includes("旧行动项"));
  assert.ok(out.includes("## 附注图表"));
  assert.ok(out.includes("![架构图](assets/arch.png)"));
  assert.ok(out.includes("这里是用户手写的补充说明"));
  // 其它小节保持不变
  assert.ok(out.includes("定位高并发下的队列挂起"));
});

test("小节缺失时追加到文末，而不是覆盖全文", () => {
  const out = patchMarkdownSections("# 标题\n\n## 项目目标\n\n旧目标\n", { sections: { lessons: "锁内严禁调用外部回调" } });
  assert.ok(out.includes("## 关键经验"));
  assert.ok(out.includes("锁内严禁调用外部回调"));
  assert.ok(out.includes("旧目标"));
});

test("答疑以追加行的形式进入待确认问题小节", () => {
  const out = patchMarkdownSections(SAMPLE, { answers: [{ question: "连接池上限是多少？", answer: "32" }] });
  assert.ok(out.includes("- 连接池上限是多少？"));
  assert.ok(out.includes("→ 32"));
  // 重复合并不应无限累积空行
  const twice = patchMarkdownSections(out, { answers: [{ question: "连接池上限是多少？", answer: "32" }] });
  assert.ok(twice.split("\n").filter((line) => line.trim() === "").length < 20);
});

test("未知小节键被忽略，避免污染正文", () => {
  const out = patchMarkdownSections(SAMPLE, { sections: { unknown: "不应写入" } });
  assert.equal(out, SAMPLE);
});
