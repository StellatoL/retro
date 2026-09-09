// 模型工具 retro_capture 与 retro_draft：写入统一经过状态存储或暂存白名单，
// 工具参数不能直接指定知识库中的任意写入路径。
import { defineTool } from "@deepseek-ai/dsh-tools";

/** 向 ctx.tools 注册素材采集和复盘草稿工具。 */
export function registerTools(ctx, store, cfg) {
  ctx.tools.register(defineTool({
    name: "retro_capture",
    description: "标记当前会话中值得沉淀到经验库的素材（重要修复、关键决策、用户纠正、踩坑）。调用后素材进入复盘管线，后续 /retro 或 /weekly 会自动纳入。",
    parameters: {
      summary: { type: "string", required: true, description: "素材摘要：发生了什么、结论是什么（一两句话，保留关键细节）" },
      importance: { type: "integer", enum: [0, 1, 2, 3], description: "重要性 0-3，默认 1（3 = 必须沉淀）" },
      links: { type: "array", items: { type: "string" }, description: "相关文件路径或引用（可选）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          materialId: { type: "string" },
          message: { type: "string" }
        }
      },
      render(args, value) {
        return [{ type: "text", text: value.ok ? `✅ 已捕获素材 ${value.materialId}` : `❌ ${value.message}` }];
      }
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted();
      const sessionId = exec?.sessionId ?? exec?.agent?.session?.id ?? null;
      const material = store.addMaterial({
        sessionId,
        kind: "manual-capture",
        summary: args.summary,
        importance: args.importance ?? 1,
        links: args.links ?? [],
        ts: Date.now()
      });
      store.audit({ actor: "tool:retro_capture", action: "capture", target: material.id, ok: true, note: args.summary.slice(0, 120) });
      return { ok: true, materialId: material.id, message: `素材已入管线（${material.id}）` };
    }
  }));

  ctx.tools.register(defineTool({
    name: "retro_draft",
    description: "为指定会话生成经验复盘卡片初稿（LLM 提炼）并写入 Obsidian 暂存区（Index/06_Retro/_retro）。生成的是草稿，必须由用户审阅后通过 /retro review 确认落库。",
    parameters: {
      sessionId: { type: "string", description: "目标会话 id（缺省为当前会话）" },
      title: { type: "string", description: "复盘标题（可选，缺省由内容生成）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          cardId: { oneOf: [{ type: "string" }, { type: "null" }] },
          path: { oneOf: [{ type: "string" }, { type: "null" }] },
          message: { type: "string" }
        }
      },
      render(args, value) {
        const text = value.ok
          ? `✅ 复盘草稿已生成：${value.path}\n卡片 id：${value.cardId}\n请在 Obsidian 中审阅，然后运行 /retro review ${value.cardId} keep`
          : `❌ ${value.message}`;
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted();
      const { distillSession } = await import("./distiller.js");
      const { draftCardFiles } = await import("./settler.js");
      const { dedupeSuggestions } = await import("./evolvor.js");

      const sessionId = args.sessionId ?? exec?.sessionId ?? exec?.agent?.session?.id ?? null;
      if (!sessionId) {
        return { ok: false, cardId: null, path: null, message: "无法确定目标会话：请显式传入 sessionId，或使用 /retro draft 命令" };
      }
      if (!ctx.sessionQuery) {
        return { ok: false, cardId: null, path: null, message: "sessionQuery 服务不可用" };
      }
      const existing = store.cardForSession(sessionId);
      if (existing) {
        return { ok: true, cardId: existing.id, path: existing.stagingPath, message: `该会话已有卡片 ${existing.id}（${existing.stagingPath}），未重复生成` };
      }

      // 合并调用者取消与工具自身的超时，防止取消后继续生成文件。
      const timeout = AbortSignal.timeout(240000);
      const signal = exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout;
      const { title, markdown } = await distillSession(ctx, cfg, sessionId, { signal });
      signal.throwIfAborted();
      const card = store.addCard({
        sessionIds: [sessionId],
        workspace: null,
        title: args.title ?? title ?? "未命名复盘",
        source: "tool",
        fields: { markdown }
      });
      const { relPath } = draftCardFiles(cfg, store, card, { markdown, actor: "tool:retro_draft" });
      const dupes = dedupeSuggestions(store, { title: card.title, takeaways: [] });
      const dupeNote = dupes.length > 0 ? `\n⚠️ 与已有经验相似：${dupes.map((d) => d.title).join("、")}（可考虑 merge）` : "";
      return {
        ok: true,
        cardId: card.id,
        path: relPath,
        message: `草稿 ${card.id} 已写入暂存区：${relPath}${dupeNote}`
      };
    }
  }));
}
