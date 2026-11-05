// JSON 状态存储：保存素材、卡片、条目、发布队列、提案和审计记录。
// v2 变更：新增 meta.schemaVersion 与单调递增的 meta.rev（供面板增量刷新与 SSE 对齐），
// 首次从 v1 加载时先备份 store.v1.bak.json，再原地升级；旧字段全部保留。
import path from "node:path";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { atomicWrite, readOptional, shortId, todayStamp } from "./util.js";

/** 当前存储结构版本；与 meta.schemaVersion 对应。 */
export const SCHEMA_VERSION = 2;

const EMPTY = () => ({
  version: 1,
  materials: [],
  cards: [],
  entries: [],
  publish: [],
  audit: [],
  proposals: [],
  meta: { schemaVersion: SCHEMA_VERSION, rev: 0, lastWeeklyCheck: null, weeklyCount: 0 }
});

/**
 * 把任意版本的已解析状态规范化为 v2 结构（纯函数，不触碰文件系统）。
 * @param {object} parsed - 已解析的 store.json 内容。
 * @returns {{ data: object, migrated: boolean }} 规范化结果与是否发生了版本升级。
 */
export function migrateStoreData(parsed) {
  const rawMeta = parsed?.meta && typeof parsed.meta === "object" ? parsed.meta : {};
  // 版本判定必须基于原始 meta，而不是与 EMPTY() 合并后的结果。
  const migrated = rawMeta.schemaVersion !== SCHEMA_VERSION;
  const base = { ...EMPTY(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  base.meta = { ...EMPTY().meta, ...rawMeta };
  for (const key of ["materials", "cards", "entries", "publish", "audit", "proposals"]) {
    if (!Array.isArray(base[key])) base[key] = [];
  }
  if (migrated) {
    // rev 用毫秒时间戳起步，避免与历史数据（无 rev）比较时出现"版本倒退"。
    base.meta.schemaVersion = SCHEMA_VERSION;
    if (!Number.isSafeInteger(base.meta.rev) || base.meta.rev <= 0) base.meta.rev = Date.now();
  }
  return { data: base, migrated };
}

export class RetroStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, "store.json");
    this.backupPath = path.join(dir, "store.v1.bak.json");
    this.migrated = false;
    mkdirSync(dir, { recursive: true });
    this.data = EMPTY();
    this.load();
  }

  load() {
    let parsed = null;
    try {
      const raw = readOptional(this.path);
      if (raw) parsed = JSON.parse(raw);
    } catch (error) {
      // 解析失败时保留内存默认值；后续保存会覆盖原文件。
      this.data = EMPTY();
      this.data.lastError = String(error?.message ?? error);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.data = EMPTY();
      return;
    }
    const { data, migrated } = migrateStoreData(parsed);
    this.data = data;
    this.migrated = migrated;
    if (migrated) {
      // 首次升级：先留 v1 备份（只创建一次，保护最原始状态），再原地写入 v2。
      try {
        if (existsSync(this.path) && !existsSync(this.backupPath)) copyFileSync(this.path, this.backupPath);
      } catch { /* 备份失败不阻断启动，迁移结果仍写入 */ }
      this.save({ bump: false });
    }
  }

  /** 写盘；默认自增 rev，供面板与 SSE 判断"是否有变化"。 */
  save({ bump = true } = {}) {
    if (bump) this.data.meta.rev = (Number(this.data.meta.rev) || 0) + 1;
    atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }

  /** 当前修订号，供 HTTP 层做 sinceRev 快速比对。 */
  getRev() {
    return Number(this.data.meta?.rev) || 0;
  }

  // 素材
  addMaterial({ sessionId = null, workspace = null, kind, summary, importance = 1, links = [], ts = Date.now() }) {
    const material = { id: `mat-${todayStamp()}-${shortId()}`, sessionId, workspace, kind, summary, importance, links, ts };
    this.data.materials.push(material);
    this.save();
    return material;
  }

  listMaterials({ since = 0, limit = 100 } = {}) {
    return this.data.materials
      .filter((m) => m.ts >= since)
      .slice(-limit)
      .reverse();
  }

  // 复盘卡片
  addCard(card) {
    const now = new Date().toISOString();
    const id = `rc-${todayStamp()}-${shortId()}`;
    const full = {
      id,
      sessionIds: [],
      workspace: null,
      title: "",
      status: "drafted",
      fields: {},
      questions: [],
      stagingPath: null,
      vaultNote: null,
      blogSlug: null,
      createdAt: now,
      updatedAt: now,
      source: "session",
      ...card
    };
    this.data.cards.push(full);
    this.save();
    return full;
  }

  getCard(id) {
    return this.data.cards.find((c) => c.id === id);
  }

  /** 查找某会话的已有卡片，用于避免重复生成草稿。 */
  cardForSession(sessionId) {
    return this.data.cards.find((c) => c.sessionIds.includes(sessionId));
  }

  updateCard(id, patch) {
    const card = this.getCard(id);
    if (!card) return null;
    Object.assign(card, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return card;
  }

  listCards(status = null) {
    const list = status ? this.data.cards.filter((c) => c.status === status) : [...this.data.cards];
    return list.reverse();
  }

  // 经验条目
  addEntry(entry) {
    const now = new Date().toISOString();
    const full = { id: `exp-${todayStamp()}-${shortId()}`, createdAt: now, updatedAt: now, ...entry };
    this.data.entries.push(full);
    this.save();
    return full;
  }

  getEntry(id) {
    return this.data.entries.find((e) => e.id === id);
  }

  updateEntry(id, patch) {
    const entry = this.getEntry(id);
    if (!entry) return null;
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return entry;
  }

  listEntries() {
    return [...this.data.entries].reverse();
  }

  // 发布队列
  addPublish(item) {
    this.data.publish.push({ id: `pub-${todayStamp()}-${shortId()}`, createdAt: new Date().toISOString(), ...item });
    this.save();
    return this.data.publish[this.data.publish.length - 1];
  }

  updatePublish(slug, patch) {
    const item = this.data.publish.find((p) => p.slug === slug);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return item;
  }

  getPublish(slug) {
    return this.data.publish.find((p) => p.slug === slug);
  }

  listPublish(status = null) {
    const list = status ? this.data.publish.filter((p) => p.status === status) : [...this.data.publish];
    return list.reverse();
  }

  // 等待用户采纳的技能或 AGENTS.md 更新提案
  addProposal(proposal) {
    const full = { id: `prop-${todayStamp()}-${shortId()}`, createdAt: new Date().toISOString(), status: "pending", ...proposal };
    this.data.proposals.push(full);
    this.save();
    return full;
  }

  getProposal(id) {
    return this.data.proposals.find((p) => p.id === id);
  }

  updateProposal(id, patch) {
    const proposal = this.getProposal(id);
    if (!proposal) return null;
    Object.assign(proposal, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return proposal;
  }

  listProposals(status = "pending") {
    return this.data.proposals.filter((p) => p.status === status);
  }

  // 审计记录
  audit({ actor, action, target, ok = true, note = null }) {
    this.data.audit.push({ ts: Date.now(), actor, action, target, ok, note });
    if (this.data.audit.length > 2000) this.data.audit = this.data.audit.slice(-2000);
    this.save();
    return this.data.audit[this.data.audit.length - 1];
  }

  listAudit(limit = 30) {
    return this.data.audit.slice(-limit).reverse();
  }

  // 周报等元数据
  getMeta() {
    return this.data.meta;
  }

  updateMeta(patch) {
    Object.assign(this.data.meta, patch);
    this.save();
  }
}
