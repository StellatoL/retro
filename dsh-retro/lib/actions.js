// 动作服务层：命令与（后续）HTTP 写接口共用的唯一实现。
// 正式落库、条目沉淀、提案采纳与暂存清理只在这里发生；
// 命令层只负责参数解析与结果展示，避免两条入口的行为漂移。
import { rmSync } from "node:fs";
import {
  ensureDirs,
  settleCard,
  settleEntry,
  draftEntryFile,
  readStaging,
  splitCardFile,
  stripQuestionsSection,
  extractEntryFromCard,
  stagingRoot
} from "./settler.js";
import { adoptProposal as adoptProposalFile, dedupeProposals, updateMoc } from "./evolvor.js";
import { safeJoin } from "./util.js";

/**
 * 创建动作服务。
 * @param {{ store: import("./store.js").RetroStore, cfg: object, logger?: object }} deps
 */
export function createActionService({ store, cfg, logger = null }) {
  const log = (message) => logger?.warn?.(`[retro] ${message}`);

  return {
    /**
     * 审阅一张卡片：keep 落库并生成经验条目草稿，discard 丢弃，edit 记录修订意见。
     * @param {{ id: string, subAction?: "keep"|"discard"|"edit", targetDir?: string, instruction?: string|null, actor?: string }} input
     * @returns {{ ok: boolean, status?: string, message: string }}
     */
    reviewCard({ id, subAction = "keep", targetDir, instruction = null, actor = "command:review" }) {
      const card = store.getCard(id);
      if (!card) throw new Error(`卡片不存在：${id}`);
      ensureDirs(cfg);
      const result = settleCard(cfg, store, card, {
        action: subAction,
        dir: targetDir,
        note: subAction === "edit" ? instruction : null,
        actor
      });
      let extra = "";
      if (result.ok && result.status === "approved") {
        // 从用户审阅后的卡片正文自动提取经验字段（而非空模板）。
        let extracted = { use: "", model: "", example: "", pitfalls: [], links: [] };
        try {
          const stagedText = readStaging(cfg, card.stagingPath);
          extracted = extractEntryFromCard(stripQuestionsSection(splitCardFile(stagedText).body));
        } catch (error) {
          log(`经验字段提取失败，使用空字段：${String(error?.message ?? error)}`);
        }
        const entry = store.addEntry({
          title: card.title,
          ...extracted,
          links: [...extracted.links, card.vaultNote ? `[[${card.vaultNote.replace(/\.md$/, "")}]]` : null].filter(Boolean),
          tags: ["experience"],
          source: "card",
          cardId: card.id,
          status: "drafted"
        });
        const { relPath } = draftEntryFile(cfg, store, entry);
        extra = `\n已生成经验条目草稿：${relPath} → 确认沉淀为永久经验：\`/retro entry keep ${entry.id}\``;
      }
      return { ...result, message: result.message + extra };
    },

    /**
     * 把经验条目沉淀为永久笔记，并刷新经验库索引。
     * @returns {{ ok: boolean, message: string, path: string, mocCount?: number }}
     */
    keepEntry({ id, actor = "command:entry" }) {
      const entry = store.getEntry(id);
      if (!entry) throw new Error(`经验条目不存在：${id}`);
      const result = settleEntry(cfg, store, entry);
      let mocNote = "";
      let mocCount;
      try {
        const moc = updateMoc(cfg, store, { actor });
        mocCount = moc.count;
        mocNote = `\n经验库索引已刷新（${moc.count} 条）：${moc.path}`;
      } catch (error) {
        // 索引失败不阻塞沉淀
        log(`经验库索引刷新失败：${String(error?.message ?? error)}`);
      }
      return { ok: true, path: result.path, mocCount, message: `已沉淀为永久经验：${result.path}${mocNote}` };
    },

    /**
     * 采纳规则提案；target 为 "all" 时先按文本相似度去重，每组只采纳代表。
     * @returns {{ ok: boolean, message: string, adopted: string[], skipped: string[] }}
     */
    adopt({ target, actor = "command:adopt" }) {
      const hasAll = target === "all";
      const adopted = [];
      const skipped = [];
      const skippedLines = [];
      let proposals;
      if (hasAll) {
        const pending = store.listProposals("pending").filter((p) => p.kind !== "retro-suggest");
        const groups = dedupeProposals(pending);
        proposals = groups.map((g) => g.representative);
        for (const group of groups) {
          for (const dup of group.duplicates) {
            store.updateProposal(dup.id, { status: "skipped", skipNote: `与 ${group.representative.title} 重复` });
            skipped.push(dup.id);
            skippedLines.push(`⏭️ ${dup.id} [${dup.kind}]「${dup.title}」→ 已跳过（与「${group.representative.title}」重复）`);
          }
        }
      } else {
        proposals = [store.getProposal(target)].filter(Boolean);
      }
      if (proposals.length === 0) {
        return { ok: false, message: `没有可采纳的提案：${target}`, adopted, skipped };
      }
      const lines = [];
      for (const proposal of proposals) {
        try {
          const result = adoptProposalFile(cfg, store, proposal);
          adopted.push(proposal.id);
          lines.push(`✅ ${proposal.id} [${proposal.kind}] → ${result.target}${result.backedUp ? "（原文件已备份 .bak）" : ""}`);
        } catch (error) {
          lines.push(`❌ ${proposal.id}：${String(error?.message ?? error)}`);
        }
      }
      if (skippedLines.length > 0) lines.push("", "去重：以下重复提案已跳过：", ...skippedLines);
      if (adopted.length > 0) {
        store.audit({ actor, action: "adopt", target: adopted.join(", "), ok: true, note: `跳过 ${skipped.length}` });
      }
      return { ok: true, message: lines.join("\n"), adopted, skipped };
    },

    /**
     * 清理已丢弃卡片的暂存文件（保持 0.5.0 语义：只删 discarded）。
     * @returns {{ ok: boolean, message: string, removed: string[], failed: string[] }}
     */
    cleanupStaging({ actor = "command:cleanup" } = {}) {
      if (!cfg.vaultPath) return { ok: false, message: "vaultPath 未配置：运行 /retro config vaultPath <路径>", removed: [], failed: [] };
      const discarded = store.listCards("discarded");
      const removed = [];
      const failed = [];
      for (const card of discarded) {
        if (!card.stagingPath) continue;
        try {
          const target = safeJoin(stagingRoot(cfg), card.stagingPath);
          rmSync(target, { force: true });
          removed.push(card.stagingPath);
        } catch {
          failed.push(card.stagingPath);
        }
      }
      if (removed.length > 0) {
        store.audit({ actor, action: "cleanup-staging", target: removed.join(", "), ok: true, note: `failed ${failed.length}` });
      }
      const lines = removed.length > 0
        ? [`✅ 已清理 ${removed.length} 个已丢弃卡片的暂存文件：`, ...removed.map((file) => `- ${file}`)]
        : ["没有可清理的已丢弃卡片暂存文件（当前无 discarded 卡片残留）"];
      if (failed.length > 0) lines.push("", `⚠️ 清理失败 ${failed.length} 个：${failed.join(", ")}`);
      return { ok: true, message: lines.join("\n"), removed, failed };
    }
  };
}
