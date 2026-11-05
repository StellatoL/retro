// 人工命令入口：/retro 管理复盘流程，/weekly 生成周报，/blog 联动博客。
// 写入动作统一委托给 lib/actions.js，命令层只做参数解析与结果展示。
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateConfig, renderConfig, saveConfig as persistConfig, loadConfig, parseConfigValue, getConfigPath, listWorkspaces, configPath, retroDir } from "./config.js";
import { distillSession, distillWeekly } from "./distiller.js";
import { draftCardFiles, draftEntryFile } from "./settler.js";
import { draftBlogFromNote, publishBlogPost, captureBlogPosts, listBlogPosts } from "./publisher.js";
import { proposeUpdate, dedupeSuggestions, dedupeBlogPosts, updateMoc } from "./evolvor.js";
import { renderReport } from "./report.js";
import { atomicWrite, clip, todayStamp, nowStamp } from "./util.js";
import { createActionService } from "./actions.js";

/** 注册插件提供的全部斜杠命令。 */
export function registerCommands(ctx, store, cfg) {
  ctx.commands.register({
    name: "retro",
    description: "经验复盘：查看队列/生成复盘草稿/确认落库/配置",
    input: { hint: "[queue|draft <scope>|review <id> keep|discard|edit <意见>|entry keep <id>|config [k v]|adopt <id|all>]" },
    handler: (invocation) => runRetro(ctx, store, cfg, invocation)
  });
  ctx.commands.register({
    name: "weekly",
    description: "生成本周复盘汇总卡片（采集本周会话 + 待审清单 + 进化建议）",
    input: { hint: "[--force]" },
    handler: (invocation) => runWeekly(ctx, store, cfg, invocation)
  });
  ctx.commands.register({
    name: "blog",
    description: "Obsidian ⇄ Blog 双向联动：列出/生成草稿/发布/抓取文章",
    input: { hint: "list | draft <notePath|cardId> [--tags a,b] [--category x] | publish <slug> [--push] | capture [recent|all]" },
    handler: (invocation) => runBlog(ctx, store, cfg, invocation)
  });
}

function ok(text) { return { kind: "success", text }; }
function err(text) { return { kind: "error", text }; }

export function parseArgs(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

export function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(a);
    if (m) {
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = m[2] ?? true;
      // 处理 --key value：将后续非选项词作为该选项的值。
      if (out[key] === true && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        out[key] = args[++i];
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// /retro 命令
// ---------------------------------------------------------------------------
async function runRetro(ctx, store, cfg, invocation) {
  try {
    const [sub, ...rest] = parseArgs(invocation.rawInput);
    if (!sub || sub === "queue") return renderQueue(store, cfg);
    if (sub === "draft") return runDraft(ctx, store, cfg, rest);
    if (sub === "review") return runReview(ctx, store, cfg, rest);
    if (sub === "entry") return runEntry(store, cfg, rest);
    if (sub === "config") return runConfig(store, cfg, rest);
    if (sub === "adopt") return runAdopt(ctx, store, cfg, rest);
    if (sub === "report") return runReport(store, cfg, rest);
    if (sub === "cleanup") return runCleanup(store, cfg, rest);
    if (sub === "workspace") return runWorkspace(store, cfg, rest);
    return err(`未知子命令 "${sub}"。用法：${invocation.rawInput.length ? "/retro queue" : "/retro [queue|draft|review|entry|config|adopt|report|cleanup|workspace]"}`);
  } catch (error) {
    return err(`/retro 失败：${String(error?.message ?? error)}`);
  }
}

/** 按平台调用默认文件打开器；独立参数便于测试时替换进程启动。 */
export function openReport(filePath, { platform = process.platform, spawnProcess = spawn } = {}) {
  const url = pathToFileURL(path.resolve(filePath)).href;
  const [command, args] = platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawnProcess(command, args, { stdio: "ignore", detached: true, windowsHide: true });
      // spawn 的启动失败通过异步 error 事件返回，不能只用 try/catch。
      child.once("error", (error) => resolve({ ok: false, error: String(error?.message ?? error) }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
    }
  });
}

/** /retro report：生成 HTML 报告，并尝试用默认浏览器打开。 */
async function runReport(store, cfg, rest) {
  try {
    const html = renderReport(store, cfg);
    const outPath = path.join(retroDir(), "retro-report.html");
    atomicWrite(outPath, html);
    const opened = await openReport(outPath);
    store.audit({ actor: "command:report", action: "render-report", target: outPath, ok: true });
    return ok(`✅ 复盘面板已生成：${outPath}\n` + (opened.ok
      ? "（已尝试在默认浏览器打开；如未弹出请手动打开该文件）"
      : `（自动打开失败：${opened.error}；请手动打开该文件）`));
  } catch (error) {
    return err(`生成报告失败：${String(error?.message ?? error)}`);
  }
}

/** /retro cleanup — 删除所有已丢弃（discarded）卡片的暂存文件（白名单内）。 */
function runCleanup(store, cfg, rest) {
  try {
    const result = createActionService({ store, cfg }).cleanupStaging({ actor: "command:cleanup" });
    return result.ok ? ok(result.message) : err(result.message);
  } catch (error) {
    return err(`清理失败：${String(error?.message ?? error)}`);
  }
}

function renderQueue(store, cfg) {
  const warnings = validateConfig(cfg);
  const lines = ["## 复盘队列", ""];

  // 待复盘建议：过滤掉已有复盘卡片的会话（避免重复建议）
  const suggestions = store
    .listProposals("pending")
    .filter((p) => p.kind === "retro-suggest" && !store.cardForSession(p.sessionId));
  if (suggestions.length > 0) {
    lines.push("### 🎯 待复盘建议");
    for (const p of suggestions.slice(-5).reverse()) {
      lines.push(`- ${p.sessionId}（${p.reason}）${p.detail ? `：${clip(p.detail, 80)}` : ""} → \`/retro draft session:${p.sessionId}\``);
    }
    lines.push("");
  }

  const drafted = store.listCards("drafted");
  if (drafted.length > 0) {
    lines.push("### 📝 待审草稿（Obsidian 暂存区）");
    for (const c of drafted) {
      lines.push(`- ${c.id}「${c.title}」→ ${c.stagingPath} → \`/retro review ${c.id} keep\``);
    }
    lines.push("");
  }

  const reviewing = store.listCards("reviewing");
  if (reviewing.length > 0) {
    lines.push("### 🔄 修订中");
    for (const c of reviewing) lines.push(`- ${c.id}「${c.title}」`);
    lines.push("");
  }

  const entries = store.listEntries().filter((e) => e.status === "drafted");
  if (entries.length > 0) {
    lines.push("### 🧩 待确认经验条目");
    for (const e of entries.slice(0, 10)) {
      lines.push(`- ${e.id}「${e.title}」（${e.source}）→ \`/retro entry keep ${e.id}\``);
    }
    lines.push("");
  }

  const proposals = store.listProposals("pending").filter((p) => p.kind !== "retro-suggest");
  if (proposals.length > 0) {
    lines.push("### 🧬 待采纳进化提案");
    for (const p of proposals) {
      lines.push(`- ${p.id} [${p.kind}] ${p.title} → \`/retro adopt ${p.id}\``);
    }
    lines.push("");
  }

  const publishes = store.listPublish("drafted");
  if (publishes.length > 0) {
    lines.push("### 📤 待发布 Blog 草稿");
    for (const p of publishes) lines.push(`- ${p.slug}「${p.title}」→ \`/blog publish ${p.slug}\``);
    lines.push("");
  }

  const meta = store.getMeta();
  if (meta.lastWeeklyCheck) {
    const days = Math.floor((Date.now() - new Date(meta.lastWeeklyCheck).getTime()) / 86400000);
    lines.push(`### 📅 周汇总\n上次：${meta.lastWeeklyCheck.slice(0, 10)}（${days} 天前）${days >= (cfg.weeklyReminderDays ?? 7) ? " → 该生成本周汇总了：`/weekly`" : ""}`);
  } else {
    lines.push("### 📅 周汇总\n尚未生成过 → `/weekly`");
  }
  lines.push("");
  const materialsToday = store.listMaterials({ since: Date.now() - 86400000 }).length;
  lines.push(`素材：今日 ${materialsToday} 条（总计 ${store.listMaterials().length}）`);
  if (warnings.length > 0) {
    lines.push("", "⚠️ " + warnings.join("；"));
  }
  return ok(lines.join("\n"));
}

async function runDraft(ctx, store, cfg, rest) {
  const [scopeArg] = rest;
  const scope = scopeArg ?? "today";
  let sessionIds = [];
  try {
    const records = await ctx.sessionQuery.listSessions();
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    if (scope.startsWith("session:")) {
      const sid = scope.slice("session:".length);
      if (!records.some((r) => r.header.id === sid)) return err(`会话不存在：${sid}`);
      sessionIds = [sid];
    } else if (scope === "today") {
      sessionIds = records
        .filter((r) => new Date(r.header.createdAt).getTime() >= startOfToday.getTime())
        .slice(0, 5)
        .map((r) => r.header.id);
    } else if (scope === "week") {
      sessionIds = records
        .filter((r) => now - new Date(r.header.createdAt).getTime() <= 7 * 86400000)
        .slice(0, 8)
        .map((r) => r.header.id);
    } else if (scope === "all") {
      sessionIds = records.slice(0, 10).map((r) => r.header.id);
    } else if (scope === "workspace") {
      const cwd = process.cwd();
      sessionIds = records
        .filter((r) => r.header.cwd && r.header.cwd === cwd)
        .slice(0, 8)
        .map((r) => r.header.id);
    } else {
      return err(`未知范围 "${scope}"。可用：today | week | all | workspace | session:<id>`);
    }
  } catch (error) {
    return err(`读取会话列表失败：${String(error?.message ?? error)}`);
  }

  if (sessionIds.length === 0) return ok("该范围内没有可复盘的会话。可指定：/retro draft session:<id>（用 /retro queue 查看建议）");

  const lines = [];
  let done = 0;
  let skipped = 0;
  const signal = AbortSignal.timeout(600000);
  for (const sid of sessionIds) {
    try {
      const existing = store.cardForSession(sid);
      if (existing) { skipped++; continue; }
      lines.push(`⏳ 提炼会话 ${sid} …`);
      const { title, markdown } = await distillSession(ctx, cfg, sid, { signal });
      const card = store.addCard({ sessionIds: [sid], title: title ?? "未命名复盘", source: "command" });
      const { relPath } = draftCardFiles(cfg, store, card, { markdown, actor: "command:retro" });
      const dupes = dedupeSuggestions(store, { title: card.title });
      lines.push(`✅ ${card.id}「${card.title}」→ ${relPath}${dupes.length > 0 ? `（⚠️ 与已有经验相似：${dupes.map((d) => d.title).join("、")}）` : ""}`);
      done++;
    } catch (error) {
      lines.push(`❌ ${sid}：${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  lines.push("", `完成：新生成 ${done} 张卡片，跳过 ${skipped} 个已有卡片。`);
  if (done > 0) lines.push("请在 Obsidian 打开暂存区审阅并修改，然后运行 `/retro review <id> keep` 落库；`/retro review <id> discard` 丢弃。");
  return ok(lines.join("\n"));
}

async function runReview(ctx, store, cfg, rest) {
  const [id, action, ...tail] = rest;
  if (!id) return err("用法：/retro review <id> [keep|discard|edit <意见>] [--dir <目录>]");
  const card = store.getCard(id);
  if (!card) return err(`卡片不存在：${id}（用 /retro queue 查看）`);
  const opts = flags(rest.slice(1));
  const act = action ?? "keep";
  if (!["keep", "discard", "edit"].includes(act)) return err(`未知操作 "${act}"。可用：keep | discard | edit <意见>`);
  if (act === "edit" && tail.length === 0) return err("edit 需要附带修改意见：/retro review <id> edit <意见>");

  try {
    const result = createActionService({ store, cfg }).reviewCard({
      id,
      subAction: act,
      targetDir: typeof opts.dir === "string" ? opts.dir : undefined,
      instruction: act === "edit" ? tail.join(" ") : null,
      actor: "command:review"
    });
    return ok(result.message);
  } catch (error) {
    return err(`落库失败：${String(error?.message ?? error)}`);
  }
}

function runEntry(store, cfg, rest) {
  const [action, id] = rest;
  if (action !== "keep" || !id) return err("用法：/retro entry keep <entryId>（用 /retro queue 查看待确认条目）");
  const entry = store.getEntry(id);
  if (!entry) return err(`经验条目不存在：${id}`);
  try {
    const result = createActionService({ store, cfg }).keepEntry({ id, actor: "command:entry" });
    return ok(result.message);
  } catch (error) {
    return err(`沉淀失败：${String(error?.message ?? error)}`);
  }
}

/**
 * 多工作区管理：workspaces 为空时沿用单库配置，行为与旧版本一致。
 * list / use <id> / add <id> <名称> <vaultPath> [blogPath] / remove <id>
 */
function runWorkspace(store, cfg, rest) {
  const [action, ...args] = rest;
  const list = Array.isArray(cfg.workspaces) ? cfg.workspaces : [];

  if (!action || action === "list") {
    const rows = listWorkspaces(cfg);
    if (rows.length === 0) {
      return ok("当前未配置工作区（使用单库配置）。\n添加：/retro workspace add <id> <名称> <vaultPath> [blogPath]");
    }
    const lines = rows.map((item) => `${item.active ? "▶" : " "} ${item.id}（${item.name}）→ ${item.vaultPath}${item.blogPath ? ` ｜ 博客 ${item.blogPath}` : ""}`);
    return ok([`## 工作区（当前：${cfg.activeWorkspace || "未启用"}）`, ...lines].join("\n"));
  }

  if (action === "add") {
    const [id, name, vaultPath, blogPath] = args;
    if (!id || !name || !vaultPath) return err("用法：/retro workspace add <id> <名称> <vaultPath> [blogPath]");
    if (list.some((item) => item && item.id === id)) return err(`工作区已存在：${id}（如需修改请先 /retro workspace remove ${id}）`);
    const next = [...list, { id, name, vaultPath, ...(blogPath ? { blogPath } : {}) }];
    // 首个工作区自动设为当前，避免"加了但没生效"的困惑。
    persistConfig({ workspaces: next, activeWorkspace: cfg.activeWorkspace || id });
    Object.assign(cfg, loadConfig(cfg));
    return ok(`已添加工作区 ${id}${cfg.activeWorkspace === id ? "（已设为当前）" : ""}\nvaultPath: ${cfg.vaultPath}`);
  }

  if (action === "use") {
    const [id] = args;
    if (!id) return err("用法：/retro workspace use <id>");
    if (!list.some((item) => item && item.id === id)) return err(`工作区不存在：${id}（用 /retro workspace list 查看）`);
    persistConfig({ activeWorkspace: id });
    Object.assign(cfg, loadConfig(cfg));
    return ok(`已切换到工作区 ${id}\nvaultPath: ${cfg.vaultPath}${cfg.blogPath ? `\nblogPath: ${cfg.blogPath}` : ""}`);
  }

  if (action === "remove") {
    const [id] = args;
    if (!id) return err("用法：/retro workspace remove <id>");
    const next = list.filter((item) => item && item.id !== id);
    if (next.length === list.length) return err(`工作区不存在：${id}`);
    persistConfig({ workspaces: next, activeWorkspace: cfg.activeWorkspace === id ? "" : cfg.activeWorkspace });
    Object.assign(cfg, loadConfig(cfg));
    return ok(`已移除工作区 ${id}${cfg.activeWorkspace ? `（当前：${cfg.activeWorkspace}）` : "（当前回到单库配置）"}`);
  }

  return err(`未知操作 "${action}"。可用：list | use <id> | add <id> <名称> <vaultPath> [blogPath] | remove <id>`);
}

function runConfig(store, cfg, rest) {
  if (rest.length === 0) {
    const warnings = validateConfig(cfg);
    return ok(`## /retro 配置\n${renderConfig(cfg)}\n\n配置文件：${configPath()}\n\n修改：/retro config <key> <value>（数值/布尔自动转换，数组用逗号分隔）${warnings.length ? `\n\n⚠️ ${warnings.join("；")}` : ""}`);
  }
  const [key, ...valueParts] = rest;
  if (valueParts.length === 0) {
    const v = getConfigPath(cfg, key);
    return ok(`${key}: ${v === undefined ? "（未设置）" : typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  const raw = valueParts.join(" ");
  const value = parseConfigValue(key, raw);
  persistConfig({ [key]: value });
  // 各服务共享同一个对象，原位更新才能让下一条命令、工具和面板立即生效。
  Object.assign(cfg, loadConfig(cfg));
  return ok(`已更新 ${key} = ${typeof value === "object" ? JSON.stringify(value) : String(value)}\n（已立即生效）\n${validateConfig(cfg).join("\n")}`);
}

export async function runAdopt(ctx, store, cfg, rest) {
  const [target] = rest;
  if (!target) return err("用法：/retro adopt <proposalId|all>（用 /retro queue 查看待采纳提案）");
  const result = createActionService({ store, cfg }).adopt({ target, actor: "command:adopt" });
  return result.ok ? ok(result.message) : err(result.message);
}

// ---------------------------------------------------------------------------
// /weekly 命令
// ---------------------------------------------------------------------------

/**
 * 同一天已存在且未处理的 weekly 卡片（防重复周报）。
 * 纯函数（可测试）：dateStr 为 YYYY-MM-DD。
 */
export function findTodayWeeklyCard(store, dateStr) {
  return store
    .listCards()
    .find((c) => c.source === "weekly" && c.status === "drafted" && String(c.title ?? "").includes(dateStr));
}

async function runWeekly(ctx, store, cfg, invocation) {
  try {
    const opts = flags(parseArgs(invocation.rawInput));
    // 防重复：今天已有未处理的周报时提示，--force 强制重新生成
    const existingWeekly = findTodayWeeklyCard(store, todayStamp());
    if (existingWeekly && opts.force !== true) {
      return ok(
        `今天已生成周报：${existingWeekly.id}「${existingWeekly.title}」\n` +
        `先处理它（/retro review ${existingWeekly.id} keep|discard），或强制重新生成：/weekly --force`
      );
    }
    const meta = store.getMeta();
    const since = meta.lastWeeklyCheck ? new Date(meta.lastWeeklyCheck).getTime() : Date.now() - 7 * 86400000;
    const sinceIso = new Date(since).toISOString();
    const signal = AbortSignal.timeout(600000);

    const records = (await ctx.sessionQuery.listSessions())
      .filter((r) => new Date(r.header.createdAt).getTime() >= since)
      .slice(0, 10);

    const summaries = [];
    const errors = [];
    for (const rec of records) {
      try {
        const { events } = await ctx.sessionQuery.readSession(rec.header.id);
        const { buildTranscript } = await import("./distiller.js");
        let summary = buildTranscript(events);
        if (summary.length > 2500) {
          const { complete } = await import("./distiller.js");
          summary = await complete(ctx, cfg, `压缩以下会话转录为 ≤800 字的要点摘要（技术决策/踩坑/结论）：\n\n${clip(summary, 12000)}`, { signal });
        }
        const snapshot = await ctx.sessionQuery.readTitle(rec.header.id);
        const title = (typeof snapshot === "string" ? snapshot : snapshot?.title) ?? rec.header.id;
        summaries.push({ sessionId: rec.header.id, title, summary });
      } catch (error) {
        errors.push(`${rec.header.id}: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }

    // 会话为空时的素材兜底：本周素材同样构成周报输入
    const materials = store.listMaterials({ since });
    if (summaries.length === 0 && materials.length > 0) {
      for (const m of materials.slice(0, 8)) {
        summaries.push({ sessionId: m.sessionId ?? "material", title: `素材：${m.kind}`, summary: m.summary });
      }
    }

    const pending = {
      cards: store.listCards("drafted").map((c) => ({ id: c.id, title: c.title })),
      entries: store.listEntries().filter((e) => e.status === "drafted").map((e) => ({ id: e.id, title: e.title })),
      proposals: store.listProposals("pending").filter((p) => p.kind !== "retro-suggest").map((p) => ({ id: p.id, kind: p.kind, title: p.title })),
      publish: store.listPublish("drafted").map((p) => ({ slug: p.slug, title: p.title })),
      materials: materials.length,
      // 反馈回灌：本周用户反馈素材进入周报输入
      feedback: materials.filter((m) => m.kind === "feedback").map((m) => m.summary).slice(-10)
    };

    const markdown = await distillWeekly(ctx, cfg, summaries, pending, { signal });
    const title = `本周复盘汇总 ${todayStamp()}`;
    const card = store.addCard({ sessionIds: records.map((r) => r.header.id), title, source: "weekly" });
    const { relPath } = draftCardFiles(cfg, store, card, { markdown, templateKind: "weekly", actor: "command:weekly" });

    // 进化闭环：把周报的"进化建议"提炼成结构化提案（skill/agents），
    // 用户 /retro adopt <id> 确认后写入 ~/.dsh/skills 或 ~/.dsh/AGENTS.md。
    const proposalLines = [];
    try {
      const { extractEvolutionSuggestions, distillProposals } = await import("./distiller.js");
      const suggestions = extractEvolutionSuggestions(markdown);
      if (suggestions.length > 0) {
        const proposals = await distillProposals(ctx, cfg, suggestions, { signal });
        for (const p of proposals) {
          const result = proposeUpdate(cfg, store, {
            kind: p.kind,
            title: p.title,
            content: p.content,
            reason: p.reason,
            actor: "command:weekly"
          });
          if (result.ok) proposalLines.push(`- ${result.id} [${p.kind}] ${p.title} → /retro adopt ${result.id}`);
        }
      }
    } catch (error) {
      proposalLines.push(`- （提案生成失败：${String(error?.message ?? error).slice(0, 120)}）`);
    }

    // 顺带刷新经验库 MOC 索引（如存在经验条目）。
    try {
      const { updateMoc } = await import("./evolvor.js");
      updateMoc(cfg, store, { actor: "command:weekly" });
    } catch { /* 经验库可能尚未使用，忽略 */ }

    store.updateMeta({ lastWeeklyCheck: new Date().toISOString(), weeklyCount: (meta.weeklyCount ?? 0) + 1 });

    const lines = [
      `✅ 周汇总卡片已生成：${relPath}（卡片 ${card.id}）`,
      "",
      `统计：本周会话 ${records.length} 个${errors.length ? `（${errors.length} 个读取失败）` : ""}，素材 ${pending.materials} 条`,
      `待审：卡片 ${pending.cards.length} / 条目 ${pending.entries.length} / 提案 ${pending.proposals.length} / blog 草稿 ${pending.publish.length}`,
      "",
      "请在 Obsidian 中审阅，再通过 /retro review <id> keep 确认落库，或用 discard 丢弃。"
    ];
    if (proposalLines.length > 0) {
      lines.push("", "🧬 本周进化提案（/retro adopt <id> 采纳）：", ...proposalLines);
    }
    if (errors.length > 0) lines.push("", "⚠️ " + errors.join("；"));
    return ok(lines.join("\n"));
  } catch (error) {
    return err(`/weekly 失败：${String(error?.message ?? error)}`);
  }
}

// ---------------------------------------------------------------------------
// /blog 命令
// ---------------------------------------------------------------------------
async function runBlog(ctx, store, cfg, invocation) {
  try {
    const args = parseArgs(invocation.rawInput);
    const [sub] = args;
    if (!sub || sub === "list") {
      const listing = listBlogPosts(cfg);
      if (!listing.ok) return err(listing.error);
      const lines = ["## Blog 文章", ""];
      for (const p of listing.posts.slice(-20).reverse()) {
        lines.push(`- ${p.draft ? "🟡" : "🟢"} ${p.slug}「${p.title}」(${p.published ?? "无日期"})`);
      }
      lines.push("", `共 ${listing.posts.length} 篇（草稿 ${listing.posts.filter((p) => p.draft).length}）`);
      return ok(lines.join("\n"));
    }

    if (sub === "draft") {
      const opts = flags(args.slice(1));
      // 路径可能含空格：把剩余非 flag token 重新拼回（无需引号）
      const source = opts._.join(" ").trim();
      if (!source) {
        // 友好提示：列出可直接作为来源的已落库卡片与最近笔记
        const approved = store.listCards("approved").filter((c) => c.vaultNote).slice(0, 5);
        const lines = [
          "用法：/blog draft <notePath|cardId>",
          "（notePath 为 vault 内相对路径，如 Index/03_Full_Notes/04_Retro/xxx.md；含空格时无需引号，直接输入完整路径）",
          ""
        ];
        if (approved.length > 0) {
          lines.push("可选卡片（cardId）：");
          for (const c of approved) lines.push(`- ${c.id}「${c.title}」→ ${c.vaultNote}`);
        } else {
          lines.push("（暂无已落库卡片；可先用 /retro review <id> keep 落库，或直接指定笔记路径）");
        }
        return ok(lines.join("\n"));
      }
      const card = source.startsWith("rc-") ? store.getCard(source) : null;
      const result = draftBlogFromNote(cfg, store, { notePath: card ? undefined : source, card, actor: "command:blog" });
      if (!result.ok) return err(result.error);
      const dupes = dedupeBlogPosts(cfg, result.title ?? "");
      return ok(
        `✅ Blog 草稿已创建：${result.path}（draft: true；请确认站点构建会排除草稿）\n` +
        `本地预览：在 ${cfg.blogPath || "blogPath（未配置）"} 运行 pnpm dev 后访问\n` +
        `发布：/blog publish ${result.slug}${cfg.blogAutoPush ? "" : " [--push]"}` +
        (dupes.length > 0 ? `\n⚠️ 与已有文章标题相似：${dupes.map((d) => d.title).join("、")}` : "")
      );
    }

    if (sub === "publish") {
      const opts = flags(args.slice(1));
      const [slug] = opts._;
      if (!slug) return err("用法：/blog publish <slug> [--push]");
      const result = await publishBlogPost(cfg, store, { slug, push: opts.push === true || cfg.blogAutoPush, actor: "command:blog" });
      if (!result.ok) return err(result.error);
      return ok(`✅ ${result.slug} 已发布（${result.pushed ? "已推送，等待 CI 构建" : "已提交未推送"}）\n${result.blogUrl ?? ""}`);
    }

    if (sub === "capture") {
      const scope = args[1] ?? "published";
      if (!["published", "recent", "all"].includes(scope)) return err("capture 范围：published | recent | all");
      const result = captureBlogPosts(cfg, store, { scope, actor: "command:blog" });
      if (!result.ok) return err(result.error);
      if (result.created.length === 0) return ok(`没有需要抓取的新文章（已抓 ${result.skipped} 篇）`);
      const lines = [`✅ 已为 ${result.created.length} 篇文章生成经验条目草稿：`, ""];
      for (const c of result.created) lines.push(`- ${c.id}「${c.title}」→ /retro entry keep ${c.id}`);
      return ok(lines.join("\n"));
    }

    return err(`未知子命令 "${sub}"。可用：list | draft | publish | capture`);
  } catch (error) {
    return err(`/blog 失败：${String(error?.message ?? error)}`);
  }
}
