// 只读查询服务：面板快照、过滤分页与实体详情。
// 快照不带参数时与 0.5.0 字段完全一致；带参数时追加 rev / page 等增量字段。
import path from "node:path";
import { readStaging, proposalsRoot, entriesRoot } from "./settler.js";
import { computeContentHash, verifyNoteScope, RetroError } from "./guard.js";
import { readOptional } from "./util.js";
import { proposalTarget } from "./evolvor.js";

/** 笔记预览的体积上限：超出部分截断并标记，避免一次响应过大。 */
const MAX_NOTE_BYTES = 262144;

/**
 * 从状态存储生成面板快照（0.5.0 兼容形态，不执行文件读取）。
 * @param {import("./store.js").RetroStore} store
 * @param {object} cfg - 合并后的配置。
 */
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

/** 编码分页游标：`updatedAt|id` 的 base64url。 */
function encodeCursor(item) {
  return Buffer.from(`${item.updatedAt ?? ""}|${item.id ?? ""}`, "utf8").toString("base64url");
}

/** 解码分页游标；损坏的游标视为从头开始。 */
function decodeCursor(raw) {
  try {
    const [updatedAt, id] = Buffer.from(String(raw), "base64url").toString("utf8").split("|");
    return { updatedAt: updatedAt ?? "", id: id ?? "" };
  } catch {
    return null;
  }
}

function cardSearchText(card) {
  const fields = card.fields && typeof card.fields === "object" ? JSON.stringify(card.fields) : "";
  return `${card.title ?? ""}\n${fields}`.toLowerCase();
}

/**
 * 创建查询服务实例。
 * @param {{ store: import("./store.js").RetroStore, cfg: object }} deps
 */
export function createQueryService({ store, cfg }) {
  const maxLimit = 100;
  const defaultLimit = 50;

  /** 卡片过滤 + 排序 + 游标分页。 */
  function queryCards(params = {}) {
    const statusFilter = params.status ? String(params.status).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const keyword = params.q ? String(params.q).trim().toLowerCase() : "";
    let rows = store.listCards();
    if (statusFilter) rows = rows.filter((card) => statusFilter.includes(card.status));
    if (keyword) rows = rows.filter((card) => cardSearchText(card).includes(keyword));

    const sort = params.sort === "createdAt:desc" ? "createdAt" : "updatedAt";
    rows = [...rows].sort((a, b) => {
      const left = String(b[sort] ?? "");
      const right = String(a[sort] ?? "");
      return left === right ? String(b.id).localeCompare(String(a.id)) : left.localeCompare(right);
    });

    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    if (cursor) {
      const at = rows.findIndex((card) => String(card[sort] ?? "") === cursor.updatedAt && card.id === cursor.id);
      if (at >= 0) rows = rows.slice(at + 1);
    }

    const limit = Math.min(maxLimit, Math.max(1, Number(params.limit) || defaultLimit));
    const page = rows.slice(0, limit);
    const hasMore = rows.length > page.length;
    return {
      resource: "cards",
      items: page.map((card) => ({
        id: card.id,
        title: card.title,
        status: card.status,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        stagingPath: card.stagingPath,
        vaultNote: card.vaultNote,
        unresolvedQuestions: Array.isArray(card.questions) ? card.questions.filter((q) => !q?.resolved).length : 0
      })),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      total: rows.length,
      limit
    };
  }

  return {
    /**
     * 面板快照：不带查询参数时与 0.5.0 完全一致；带参数时追加 rev / page。
     * @param {Record<string, string>} params - 来自 URL 查询串。
     */
    getSnapshot(params = {}) {
      const rev = store.getRev();
      const since = params.sinceRev;
      if (since !== undefined && since !== null && Number(since) === rev) {
        // 未变化时只返回极小响应，供客户端做轻量轮询。
        return { unchanged: true, rev };
      }
      const snapshot = {
        ...renderPanelApi(store, cfg),
        rev,
        writeApiEnabled: cfg.security?.enableWriteApi === true
      };
      const wantsPage = ["resource", "status", "q", "limit", "cursor", "sort"].some((key) => params[key] !== undefined);
      if (wantsPage) snapshot.page = queryCards(params);
      return snapshot;
    },

    /**
     * 实体详情：卡片 / 提案 / 经验条目 / 白名单笔记。
     * @param {{ type: string, id: string }} input
     */
    getEntityDetail({ type, id }) {
      if (!type || !id) throw new RetroError("RETRO_BAD_REQUEST", "缺少 type 或 id 参数", { status: 400 });
      if (type === "card") {
        const card = store.getCard(id);
        if (!card) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `卡片不存在：${id}`, { status: 404 });
        let rawMarkdown = null;
        if (card.stagingPath) {
          try { rawMarkdown = readStaging(cfg, card.stagingPath); } catch { rawMarkdown = null; }
        }
        return {
          ok: true,
          type: "card",
          id,
          meta: {
            title: card.title,
            status: card.status,
            stagingPath: card.stagingPath,
            vaultNote: card.vaultNote,
            // 供面板直接打开 Obsidian：优先正式笔记，其次暂存区完整相对路径。
            note: card.vaultNote ?? (cfg.stagingDir && card.stagingPath ? `${cfg.stagingDir}/${card.stagingPath}` : card.stagingPath ?? null),
            sessionIds: card.sessionIds ?? [],
            questions: card.questions ?? [],
            createdAt: card.createdAt,
            updatedAt: card.updatedAt
          },
          contentHash: rawMarkdown === null ? null : computeContentHash(rawMarkdown),
          rawMarkdown
        };
      }
      if (type === "proposal") {
        const proposal = store.getProposal(id);
        if (!proposal) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `提案不存在：${id}`, { status: 404 });
        let rawMarkdown = null;
        if (proposal.relPath) {
          try { rawMarkdown = readStaging(cfg, proposal.relPath); } catch { rawMarkdown = null; }
        }
        const target = proposalTarget(proposal.kind);
        return {
          ok: true,
          type: "proposal",
          id,
          meta: {
            kind: proposal.kind,
            title: proposal.title,
            reason: proposal.reason ?? null,
            status: proposal.status,
            relPath: proposal.relPath ?? null,
            targetFile: target?.path ?? null
          },
          rawMarkdown
        };
      }
      if (type === "entry") {
        const entry = store.getEntry(id);
        if (!entry) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `经验条目不存在：${id}`, { status: 404 });
        let rawMarkdown = null;
        if (entry.draftPath) {
          try {
            const abs = path.join(entriesRoot(cfg), String(entry.draftPath).replace(/^_entries[\\/]/, ""));
            rawMarkdown = readOptional(abs) ?? null;
          } catch { rawMarkdown = null; }
        }
        return { ok: true, type: "entry", id, meta: { title: entry.title, status: entry.status, notePath: entry.notePath ?? null }, rawMarkdown };
      }
      if (type === "note") {
        // 默认只允许 Index/06_Retro/ 下的插件产物；越界与作用域外分别报错。
        const abs = verifyNoteScope(cfg, id);
        const text = readOptional(abs);
        if (text === undefined) throw new RetroError("RETRO_ENTITY_NOT_FOUND", `笔记不存在：${id}`, { status: 404 });
        const truncated = Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES;
        return { ok: true, type: "note", id, rawMarkdown: truncated ? text.slice(0, MAX_NOTE_BYTES) : text, truncated };
      }
      throw new RetroError("RETRO_BAD_REQUEST", `未知的详情类型：${type}`, { status: 400, hint: "可用：card / proposal / entry / note" });
    },

    /** 提案暂存目录，供面板展示提案来源。 */
    proposalsRoot: () => proposalsRoot(cfg)
  };
}
