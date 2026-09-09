// 面板 API：生成状态快照，并按需注册宿主 HTTP 路由。
import path from "node:path";

/** 从状态存储生成面板快照，不执行文件读写。 */
export function renderPanelApi(store, cfg = {}) {
  const meta = store.getMeta();
  const cards = store.listCards();
  const entries = store.listEntries();
  const proposals = store.listProposals();
  const publishes = store.listPublish();
  const materials = store.listMaterials({ limit: 500 });

  // vault 相对路径（供客户端打开 Obsidian / 复制命令）
  const cardNote = (c) => c.vaultNote || (c.stagingPath ? (cfg.stagingDir ? `${cfg.stagingDir}/${c.stagingPath}` : c.stagingPath) : null);
  const entryNote = (e) =>
    e.notePath ? e.notePath : cfg.entriesDir && e.draftPath ? `${cfg.entriesDir}/${String(e.draftPath).replace(/^_entries\//, "")}` : e.draftPath;

  return {
    generatedAt: new Date().toISOString(),
    vaultName: cfg.vaultPath ? path.basename(cfg.vaultPath) : null,
    stats: {
      cards: cards.length,
      draftedCards: cards.filter((c) => c.status === "drafted").length,
      approvedCards: cards.filter((c) => c.status === "approved").length,
      entries: entries.length,
      draftedEntries: entries.filter((e) => e.status === "drafted").length,
      proposals: proposals.length,
      pendingProposals: proposals.filter((p) => p.status === "pending" && p.kind !== "retro-suggest").length,
      publish: publishes.length,
      publishedPosts: publishes.filter((p) => p.status === "published").length,
      materials: materials.length,
      weeklyCount: meta.weeklyCount ?? 0,
      lastWeeklyCheck: meta.lastWeeklyCheck ?? null
    },
    queue: {
      cards: cards.filter((c) => c.status === "drafted").map((c) => ({
        id: c.id, title: c.title, path: c.stagingPath, note: cardNote(c), createdAt: c.createdAt
      })),
      entries: entries.filter((e) => e.status === "drafted").map((e) => ({ id: e.id, title: e.title, note: entryNote(e) })),
      proposals: proposals
        .filter((p) => p.status === "pending" && p.kind !== "retro-suggest")
        .map((p) => ({ id: p.id, kind: p.kind, title: p.title, reason: p.reason }))
    },
    recentApproved: cards
      .filter((c) => c.status === "approved" && c.vaultNote)
      .slice(0, 5)
      .map((c) => ({ id: c.id, title: c.title, note: c.vaultNote })),
    recentAudit: store.listAudit(10).map((a) => ({
      ts: a.ts, actor: a.actor, action: a.action, target: a.target, ok: a.ok
    }))
  };
}

/**
 * 向可选的 webServer 服务注册只读路由。
 * 返回可选依赖的注入实例，由插件生命周期负责释放。
 */
export function registerPanelApi(ctx, store, cfg = {}) {
  const fiber = ctx.inject(["webServer"], (childCtx) => {
    childCtx.effect(() => childCtx.webServer.register({
      kind: "exact",
      path: "/retro/api",
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { allow: "GET, HEAD" });
          res.end();
          return;
        }
        const body = JSON.stringify(renderPanelApi(store, cfg));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(req.method === "HEAD" ? undefined : body);
      }
    }), "retro.panelApi");
  });
  return fiber;
}
