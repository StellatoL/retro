// 将复盘状态渲染成独立 HTML 报告，不执行文件读写。
import { todayStamp, nowStamp } from "./util.js";

const STATUS_BADGE = {
  suggested: "灰", drafted: "蓝", reviewing: "橙", approved: "绿",
  published: "绿", archived: "灰", discarded: "灰", pending: "蓝", adopted: "绿"
};
const STATUS_COLOR = {
  suggested: "#8a8f98", drafted: "#3b82f6", reviewing: "#f59e0b", approved: "#22c55e",
  published: "#22c55e", archived: "#8a8f98", discarded: "#8a8f98", pending: "#3b82f6", adopted: "#22c55e"
};

function badge(status) {
  const color = STATUS_COLOR[status] ?? "#8a8f98";
  return `<span class="badge" style="background:${color}1a;color:${color};border:1px solid ${color}44">${esc(status)}</span>`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statCard(label, value, hint = "") {
  return `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div>${hint ? `<div class="stat-hint">${esc(hint)}</div>` : ""}</div>`;
}

/** 根据当前状态快照生成完整报告。 */
export function renderReport(store, cfg = {}) {
  const meta = store.getMeta();
  const cards = store.listCards();
  const entries = store.listEntries();
  const proposals = store.listProposals();
  const publishes = store.listPublish();
  const materials = store.listMaterials({ limit: 500 });
  const audit = store.listAudit(30);

  const drafts = cards.filter((c) => c.status === "drafted");
  const approved = cards.filter((c) => c.status === "approved");
  const pendingEntries = entries.filter((e) => e.status === "drafted");
  const pendingProps = proposals.filter((p) => p.status === "pending" && p.kind !== "retro-suggest");

  const cardRows = cards.length
    ? cards.map((c) => `
      <tr>
        <td class="mono">${esc(c.id)}</td>
        <td>${esc(c.title)}</td>
        <td>${badge(c.status)}</td>
        <td>${esc(c.sessionIds.join(", "))}</td>
        <td class="mono">${esc(c.stagingPath ?? c.vaultNote ?? "—")}</td>
        <td class="mono">${esc((c.createdAt ?? "").slice(0, 10))}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">暂无复盘卡片</td></tr>`;

  const entryRows = entries.length
    ? entries.map((e) => `
      <tr>
        <td class="mono">${esc(e.id)}</td>
        <td>${esc(e.title)}</td>
        <td>${badge(e.status)}</td>
        <td>${esc(e.source)}</td>
        <td class="mono">${esc(e.notePath ?? e.draftPath ?? "—")}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">暂无经验条目</td></tr>`;

  const proposalRows = proposals.length
    ? proposals.map((p) => `
      <tr>
        <td class="mono">${esc(p.id)}</td>
        <td>${esc(p.kind)}</td>
        <td>${esc(p.title)}</td>
        <td>${badge(p.status)}</td>
        <td>${esc(p.reason ?? "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">暂无进化提案</td></tr>`;

  const publishRows = publishes.length
    ? publishes.map((p) => `
      <tr>
        <td class="mono">${esc(p.slug)}</td>
        <td>${esc(p.title)}</td>
        <td>${badge(p.status)}</td>
        <td class="mono">${esc(p.publishedAt ?? "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="empty">暂无发布记录</td></tr>`;

  const auditRows = audit.length
    ? audit.map((a) => `
      <tr>
        <td class="mono">${new Date(a.ts).toLocaleString("zh-CN")}</td>
        <td class="mono">${esc(a.actor)}</td>
        <td class="mono">${esc(a.action)}</td>
        <td class="mono">${esc(a.target)}</td>
        <td>${a.ok ? "✅" : "❌"}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">暂无审计记录</td></tr>`;

  const materialKinds = {};
  for (const m of materials) materialKinds[m.kind] = (materialKinds[m.kind] ?? 0) + 1;
  const kindText = Object.entries(materialKinds)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ") || "—";

  const lastWeekly = meta.lastWeeklyCheck ? new Date(meta.lastWeeklyCheck).toLocaleString("zh-CN") : "从未";

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-retro 复盘面板 — ${todayStamp()}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e8ee; }
  header { padding: 24px 32px; border-bottom: 1px solid #ffffff14; display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 20px; }
  header .sub { color: #8a8f98; font-size: 13px; }
  main { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: #161a22; border: 1px solid #ffffff12; border-radius: 10px; padding: 14px 16px; }
  .stat-value { font-size: 26px; font-weight: 600; }
  .stat-label { color: #8a8f98; font-size: 12px; margin-top: 2px; }
  .stat-hint { color: #5c6470; font-size: 11px; margin-top: 4px; }
  section { margin-bottom: 28px; }
  section h2 { font-size: 15px; margin: 0 0 10px; color: #c9ced8; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #161a22; border: 1px solid #ffffff12; border-radius: 10px; overflow: hidden; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ffffff0d; vertical-align: top; }
  th { color: #8a8f98; font-weight: 500; font-size: 12px; background: #1a1f29; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: Consolas, monospace; font-size: 12px; color: #9aa4b2; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .empty { color: #5c6470; text-align: center; padding: 16px; }
  footer { color: #5c6470; font-size: 12px; padding: 16px 32px 32px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>🗂 dsh-retro 复盘面板</h1>
  <div class="sub">生成于 ${esc(nowStamp())} · 数据源 ~/.dsh/retro/store.json</div>
</header>
<main>
  <div class="stats">
    ${statCard("复盘卡片", cards.length, `${drafts.length} 张草稿 · ${approved.length} 张已落库`)}
    ${statCard("经验条目", entries.length, `${pendingEntries.length} 条待确认`)}
    ${statCard("进化提案", proposals.length, `${pendingProps.length} 条待采纳`)}
    ${statCard("发布记录", publishes.length, `${publishes.filter((p) => p.status === "published").length} 篇已发布`)}
    ${statCard("素材", materials.length, kindText)}
    ${statCard("周汇总", meta.weeklyCount ?? 0, `上次：${esc(lastWeekly)}`)}
  </div>

  <section>
    <h2>复盘卡片</h2>
    <table>
      <thead><tr><th>ID</th><th>标题</th><th>状态</th><th>会话</th><th>文件</th><th>创建</th></tr></thead>
      <tbody>${cardRows}</tbody>
    </table>
  </section>

  <section>
    <h2>经验条目</h2>
    <table>
      <thead><tr><th>ID</th><th>标题</th><th>状态</th><th>来源</th><th>文件</th></tr></thead>
      <tbody>${entryRows}</tbody>
    </table>
  </section>

  <section>
    <h2>进化提案</h2>
    <table>
      <thead><tr><th>ID</th><th>类型</th><th>标题</th><th>状态</th><th>理由</th></tr></thead>
      <tbody>${proposalRows}</tbody>
    </table>
  </section>

  <section>
    <h2>发布队列</h2>
    <table>
      <thead><tr><th>Slug</th><th>标题</th><th>状态</th><th>发布时间</th></tr></thead>
      <tbody>${publishRows}</tbody>
    </table>
  </section>

  <section>
    <h2>最近审计（30 条）</h2>
    <table>
      <thead><tr><th>时间</th><th>来源</th><th>动作</th><th>目标</th><th>结果</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>
  </section>
</main>
<footer>dsh-retro · 经验复盘管线 · 由 /retro report 生成</footer>
</body>
</html>`;
}
