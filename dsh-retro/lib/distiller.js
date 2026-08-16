// dsh-retro: distiller — turns session event logs into structured retro cards
// and weekly digests via ctx.llm (map-reduce over long transcripts).
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { clip, textOf, cleanTitle } from "./util.js";
export { cleanTitle } from "./util.js";

const RETRO_SYSTEM = `你是复盘教练（retro coach）。基于提供的会话事实材料，生成一份"经验复盘卡片"初稿。

必须遵守：
1. 只写材料中真实发生的事实；不确定的标注"（存疑）"，绝不编造。
2. 正文用中文，具体、诚实，保留可复现代码/命令/文件路径；拒绝空话套话。
3. 第一行输出一级标题：# <复盘标题>（一句话概括本次复盘主题，≤20 字，不要用 ##）。
4. 标题之后，结构严格如下（Markdown 小节）：
   ## 项目目标（一句话）
   ## 环境与栈
   ## 关键过程（3-6 条要点）
   ## 踩坑与根因（每条：现象 / 根因 / 修复）
   ## 关键经验（可复用到下一个工程的通用经验，2-5 条）
   ## 行动项（- [ ] 形式）
   ## 参考链接（如有）
5. 正文结束后输出分隔线，然后输出 "## 待确认问题"，列出 3-8 个需要向用户确认的问题（只列问题，不代答），例如：哪些结论你希望保留？这个踩坑是否值得沉淀为永久经验？`;

const WEEKLY_SYSTEM = `你是周报编辑。基于本周各会话的摘要与统计，生成一份"本周复盘汇总"卡片。

必须遵守：
1. 只使用提供的事实；不确定处标注"（存疑）"。
2. 用中文，具体诚实，拒绝空话。
3. 结构：
   ## 本周三件事（最重要/最值得记录的 3 件事，每件一句话+一句为什么值得记录）
   ## 本周推进情况（按会话/工程列出要点）
   ## 踩坑与根因（现象/根因/修复）
   ## 可复用经验（2-5 条）
   ## 待审清单（按提供的待审数据列出，原样保留 id）
   ## 下周重点建议
4. 最后输出 "## 进化建议"，基于本周内容给出 1-3 条"沉淀为技能/永久经验"的建议（例如：把某个反复出现的坑写进 retro-writing 技能）。`;

/** One LLM text completion via ctx.llm; system instructions are embedded in the user prompt. */
export async function complete(ctx, cfg, prompt, { signal, system } = {}) {
  const messages = [
    createUserMessage({
      // The harness message shape requires content as a BLOCKS array
      // (the DeepSeek adapter flattens `message.content.filter(...)`).
      content: [{ type: "text", text: [system, prompt].filter(Boolean).join("\n\n") }],
      source: { kind: "user", agent: "dsh-retro" }
    })
  ];
  const request = {
    provider: cfg.llmProvider,
    model: cfg.llmModel,
    messages,
    ...(signal ? { signal } : {})
  };
  const assembler = new BlockAssembler();
  const stream = ctx.llm.stream(request);
  for await (const chunk of stream) {
    assembler.push(chunk);
    signal?.throwIfAborted();
  }
  const finish = assembler.finish;
  if (finish.kind === "error" || finish.kind === "aborted") {
    const failure = finish.failure ?? {};
    throw new Error(`LLM 调用失败（${finish.kind}）：${String(failure.message ?? failure.code ?? failure)}`);
  }
  return assembler
    .blocks()
    .map((b) => (b.type === "text" ? String(b.text ?? "") : ""))
    .join("")
    .trim();
}

/** Build a transcript from one session's events (cheap heuristics, no LLM). */
export function buildTranscript(events) {
  const lines = [];
  const push = (prefix, text) => {
    const t = String(text ?? "").trim();
    if (t) lines.push(`${prefix} ${clip(t, 600)}`);
  };
  for (const ev of events ?? []) {
    const type = ev?.type;
    const data = ev?.data ?? ev ?? {};
    try {
      switch (type) {
        case "user/message":
          push("用户:", textOf(data.message));
          break;
        case "assistant/message":
          push("助手:", textOf(data.message));
          break;
        case "tool/call": {
          const name = data.name ?? data.tool ?? "tool";
          const args = data.arguments ?? data.input ?? data.params ?? {};
          push("工具调用:", `${name}(${clip(JSON.stringify(args), 300)})`);
          break;
        }
        case "tool/result": {
          const ok = data.ok !== false && data.error === undefined;
          if (!ok) push("工具失败:", `${data.name ?? data.tool ?? "tool"} ${clip(String(data.error ?? data.message ?? ""), 300)}`);
          break;
        }
        case "goal/change": {
          const goal = data.goal ?? data;
          push("目标:", `${goal?.objective ?? "(无描述)"} → ${goal?.phase ?? "?"}`);
          break;
        }
        case "feedback/record":
          push("用户反馈:", clip(JSON.stringify(data), 200));
          break;
        default:
          break;
      }
    } catch {
      // Skip malformed events; never break the pipeline.
    }
  }
  return lines.join("\n");
}

/** Distill one session into a retro card markdown (map-reduce when long). */
export async function distillSession(ctx, cfg, sessionId, { signal } = {}) {
  const { events } = await ctx.sessionQuery.readSession(sessionId);
  const transcript = buildTranscript(events);
  if (!transcript.trim()) {
    return { title: null, markdown: "（该会话没有可提炼的内容：无消息、无工具调用、无目标事件）" };
  }
  const material = await reduceTranscript(ctx, cfg, transcript, { signal });
  const markdown = await complete(ctx, cfg, `会话材料：\n${clip(material, cfg.distillMaxChars * 2)}\n\n请按结构生成复盘卡片初稿。`, { signal, system: RETRO_SYSTEM });
  const title = guessTitle(markdown);
  return { title, markdown };
}

/** Distill a set of sessions into a weekly digest markdown. */
export async function distillWeekly(ctx, cfg, summaries, pending, { signal } = {}) {
  const digestInput = [
    "本周会话摘要：",
    ...summaries.map((s, i) => `### 会话 ${i + 1}（${s.title ?? s.sessionId}）\n${clip(s.summary, 2500)}`),
    "",
    "本周统计：",
    `会话数 ${summaries.length}`,
    "",
    "待审数据：",
    clip(JSON.stringify(pending, null, 2), 2000)
  ].join("\n");
  return complete(ctx, cfg, `周报材料：\n${digestInput}\n\n请生成本周复盘汇总卡片。`, { signal, system: WEEKLY_SYSTEM });
}

/**
 * Extract the "## 进化建议" section from a weekly card into plain list items.
 * Supports "- "/"* " bullets and numbered lists ("1. ", "1、", "1)").
 * Pure function (testable, no LLM).
 */
export function extractEvolutionSuggestions(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const items = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+/.test(line)) {
      inSection = line.includes("进化建议");
      continue;
    }
    if (!inSection) continue;
    if (/^[-*]\s+/.test(line) || /^\d+[.、)）]\s*/.test(line)) {
      const text = line.replace(/^[-*]\s+|^\d+[.、)）]\s*/, "").trim();
      if (text) items.push(text);
    }
  }
  return items;
}

/**
 * Turn weekly evolution suggestions into structured proposals:
 * [{ kind: 'skill'|'agents', title, content, reason }].
 * One LLM call for the whole batch; falls back to plain entries on failure
 * (the caller decides whether to keep them).
 */
export async function distillProposals(ctx, cfg, suggestions, { signal } = {}) {
  if (!suggestions || suggestions.length === 0) return [];
  const prompt = [
    "把以下每周进化建议整理成结构化提案（用于更新 AI 的复盘技能 SKILL.md 或全局偏好 AGENTS.md）。",
    "输出严格 JSON 数组，每项：{kind, title, content, reason}",
    "- kind: 更新技能取 \"skill\"，更新全局偏好/习惯取 \"agents\"",
    "- title: 提案短标题（≤20 字）",
    "- content: 可直接追加到目标文件的 Markdown 片段（规则/要点，≤150 字，具体可操作，不含空话）",
    "- reason: 一句话说明为什么值得沉淀（≤40 字）",
    "只输出 JSON，不要其它文字。",
    "",
    "建议：",
    ...suggestions.map((s, i) => `${i + 1}. ${s}`)
  ].join("\n");
  const raw = await complete(ctx, cfg, prompt, { signal });
  const m = /\[[\s\S]*\]/.exec(raw);
  if (!m) throw new Error("进化提案解析失败：输出中无 JSON 数组");
  const parsed = JSON.parse(m[0]);
  if (!Array.isArray(parsed)) throw new Error("进化提案解析失败：非数组");
  return parsed
    .filter((p) => p && typeof p === "object" && (p.kind === "skill" || p.kind === "agents"))
    .map((p) => ({
      kind: p.kind,
      title: String(p.title ?? "进化建议").slice(0, 20),
      content: String(p.content ?? "").slice(0, 500),
      reason: String(p.reason ?? "").slice(0, 60)
    }))
    .filter((p) => p.content.length > 0);
}

async function reduceTranscript(ctx, cfg, transcript, { signal }) {
  if (transcript.length <= cfg.distillMaxChars) return transcript;
  const chunks = [];
  for (let i = 0; i < transcript.length; i += cfg.chunkChars) {
    chunks.push(transcript.slice(i, i + cfg.chunkChars));
  }
  const partials = [];
  for (const [i, chunk] of chunks.entries()) {
    const partial = await complete(
      ctx, cfg,
      `这是长对话的第 ${i + 1}/${chunks.length} 段。请提取事实要点：技术决策、踩坑、修复、结论。输出简洁要点列表（保留代码/命令片段）。\n\n${chunk}`,
      { signal }
    );
    partials.push(partial);
  }
  return partials.map((p, i) => `[片段 ${i + 1} 要点]\n${p}`).join("\n\n");
}

function guessTitle(markdown) {
  const m = /^#{1,6}\s+(.+)$/m.exec(markdown);
  if (m) return cleanTitle(m[1]);
  const line = markdown.split("\n").find((l) => l.trim().length > 0);
  return line ? clip(cleanTitle(line), 40) : "未命名复盘";
}
