// 事件采集器：从会话事件中提取复盘素材，并按需创建待处理建议。
// 按 dsh-session 0.1.2-rc.1 区分日志事件与生命周期通知：
// goal/change、feedback/record 等经 session/event 接收，
// session/disposed 则单独订阅；global: true 可接收各会话的事件。

const RETRO_INTENT_RE = /(复盘|总结|沉淀|回炉|经验|retro)/i;
const RETRO_IMPORTANCE = { goal: 3, feedback: 2, intent: 2, disposed: 1, toolError: 2 };

export function attachCollector(ctx, store, cfg) {
  const seenGoalSessions = new Set();
  // callId → 工具名（tool/result 里没有工具名，只能与配对的 tool/call 关联）
  const callIdToTool = new Map();
  const MAX_CALL_TRACK = 5000;

  ctx.on("session/event", (session, event) => {
    observe(session, event);
  }, { global: true });

  // 销毁是独立生命周期通知，不属于追加到日志中的 session/event。
  ctx.on("session/disposed", (session) => {
    observe(session, { type: "session/disposed" });
  }, { global: true });

  function observe(session, event) {
    try {
      handleEvent(session, event);
    } catch (error) {
      ctx.logger?.warn?.(`[retro] 采集失败：${String(error?.message ?? error)}`);
    }
  }

  function hasPendingSuggestion(sessionId) {
    return store.listProposals("pending").some((p) => p.kind === "retro-suggest" && p.sessionId === sessionId);
  }

  function sessionIdOf(session, event) {
    const id = session?.id ?? event?.data?.sessionId ?? event?.sessionId ?? null;
    if (typeof id === "string" && id.length > 0) return id;
    return null;
  }

  function handleEvent(session, event) {
    if (!event || typeof event.type !== "string") return;
    const sid = sessionIdOf(session, event);
    const workspace = session?.header?.cwd ?? session?.cwd ?? null;

    switch (event.type) {
      case "tool/call": {
        const data = event.data ?? {};
        if (typeof data.callId === "string" && typeof data.name === "string") {
          callIdToTool.set(data.callId, data.name);
          if (callIdToTool.size > MAX_CALL_TRACK) {
            // 粗粒度防膨胀：清掉最早的 1/4
            const keys = [...callIdToTool.keys()].slice(0, Math.floor(MAX_CALL_TRACK / 4));
            for (const k of keys) callIdToTool.delete(k);
          }
        }
        break;
      }
      case "goal/change": {
        const goal = event.data?.goal ?? event.data;
        const phase = goal?.phase ?? event.data?.phase;
        if (cfg.autoProposeOnGoalComplete !== false && phase === "complete" && sid) {
          if (seenGoalSessions.has(sid)) return;
          seenGoalSessions.add(sid);
          // 该会话已有复盘卡片（草稿/已落库）时不再重复建议
          if (store.cardForSession(sid)) return;
          const objective = goal?.objective ?? "（无目标描述）";
          store.addMaterial({ sessionId: sid, workspace, kind: "goal-complete", summary: `目标完成：${objective}`, importance: RETRO_IMPORTANCE.goal });
          if (!hasPendingSuggestion(sid)) {
            store.addProposal({ kind: "retro-suggest", sessionId: sid, reason: "goal-complete", detail: objective });
          }
          store.audit({ actor: "collector", action: "propose", target: `session:${sid}`, note: "goal-complete" });
        }
        break;
      }
      case "feedback/record": {
        if (!sid) break;
        const rating = event.data?.rating ?? event.data?.value ?? null;
        const note = event.data?.note ?? event.data?.comment ?? null;
        const summary = `用户反馈${rating !== null ? `（${String(rating)}）` : ""}${note ? `：${String(note).slice(0, 200)}` : ""}`;
        store.addMaterial({ sessionId: sid, workspace, kind: "feedback", summary, importance: RETRO_IMPORTANCE.feedback });
        break;
      }
      case "session/disposed": {
        if (!sid || store.cardForSession(sid) || hasPendingSuggestion(sid)) break;
        store.addProposal({ kind: "retro-suggest", sessionId: sid, reason: "session-disposed", detail: "会话已结束，可考虑复盘" });
        store.audit({ actor: "collector", action: "propose", target: `session:${sid}`, note: "session-disposed" });
        break;
      }
      case "user/message": {
        const text = textOf(event.data?.message);
        if (RETRO_INTENT_RE.test(text) && sid) {
          store.addMaterial({ sessionId: sid, workspace, kind: "intent", summary: `用户提出复盘意向：${text.slice(0, 120)}`, importance: RETRO_IMPORTANCE.intent });
        }
        break;
      }
      case "tool/result": {
        const data = event.data ?? {};
        // 真实结构：data = { turn, step, message, meta?, error? }
        // 错误标志：data.error 存在（对象 {name, code}）或 message 块 isError === true
        const block = data.message?.content?.[0];
        const isError = data.error !== undefined || block?.isError === true;
        if (isError && sid) {
          const callId = data.message?.source?.callId ?? block?.toolCallId ?? null;
          const tool = (typeof callId === "string" ? callIdToTool.get(callId) : undefined) ?? data.name ?? "tool";
          const code = data.error?.code ?? data.error?.name ?? null;
          const text = typeof block?.content?.[0]?.text === "string" ? block.content[0].text : "";
          const detail = (code ? `${code}` : "") + (text ? (code ? `：` : "") + text.slice(0, 180) : "");
          store.addMaterial({ sessionId: sid, workspace, kind: "tool-error", summary: `工具失败 ${tool}${detail ? `：${detail}` : ""}`, importance: RETRO_IMPORTANCE.toolError });
        }
        break;
      }
      default:
        break;
    }
  }
}

function textOf(message) {
  if (message == null) return "";
  const content = message.content ?? message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? String(b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
