// dsh-retro: durable JSON store (materials, cards, entries, publish queue, audit).
import path from "node:path";
import { mkdirSync } from "node:fs";
import { atomicWrite, readOptional, shortId, todayStamp } from "./util.js";

const EMPTY = () => ({
  version: 1,
  materials: [],
  cards: [],
  entries: [],
  publish: [],
  audit: [],
  proposals: [],
  meta: { lastWeeklyCheck: null, weeklyCount: 0 }
});

export class RetroStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, "store.json");
    mkdirSync(dir, { recursive: true });
    this.data = EMPTY();
    this.load();
  }

  load() {
    try {
      const raw = readOptional(this.path);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ...EMPTY(), ...parsed };
      }
    } catch (error) {
      // Corrupt store: keep in-memory defaults; next save overwrites.
      this.data = EMPTY();
      this.data.lastError = String(error?.message ?? error);
    }
  }

  save() {
    atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }

  // ---- materials ----
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

  // ---- cards ----
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

  /** Cards for a session (dedupe: avoid double-drafting one session). */
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

  // ---- entries (permanent experience atoms) ----
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

  // ---- publish queue ----
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

  // ---- proposals (skill / AGENTS.md updates awaiting user adoption) ----
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

  // ---- audit ----
  audit({ actor, action, target, ok = true, note = null }) {
    this.data.audit.push({ ts: Date.now(), actor, action, target, ok, note });
    if (this.data.audit.length > 2000) this.data.audit = this.data.audit.slice(-2000);
    this.save();
    return this.data.audit[this.data.audit.length - 1];
  }

  listAudit(limit = 30) {
    return this.data.audit.slice(-limit).reverse();
  }

  // ---- meta ----
  getMeta() {
    return this.data.meta;
  }

  updateMeta(patch) {
    Object.assign(this.data.meta, patch);
    this.save();
  }
}
