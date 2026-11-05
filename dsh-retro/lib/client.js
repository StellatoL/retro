// dsh-retro 客户端（单文件、零构建）。
// 结构分节：
//   [1] 样式注入与常量
//   [2] 安全 Markdown 渲染（零 innerHTML，全部 React 节点）
//   [3] 数据层：快照 / 详情 / 写动作 / SSE + 兜底轮询
//   [4] 组件：侧边栏图标（自绘角标）、工作台（列表 + 详情）
//   [5] 挂载：main 面板、sidebar.panellist 行、浮动按钮兜底
// 约束：只使用宿主提供的 React；全部内容以 React 节点渲染（不做 HTML 注入）；
//      卸载时必须清理 EventSource、定时器、样式与槽位注册。
window.__ModuleLoader__.load({
  id: "dsh-retro",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    var PANEL_ID = "dsh-retro";
    var FAB_DELAY_MS = 600;
    var SSE_PROBE_MS = 15000;
    var POLL_VISIBLE_MS = 15000;
    var POLL_HIDDEN_MS = 60000;
    var PAGE_LIMIT = 50;

    // ---------------------------------------------------------------------
    // [1] 样式：只使用宿主 --dsw-alias-* 语义 token，不写死颜色
    // ---------------------------------------------------------------------
    var STYLE_ID = "dsh-retro-styles";
    var PANEL_CSS = [
      ".dsh-retro-main{height:100%;display:flex;gap:0;color:var(--dsw-alias-label-primary,#e6e8ee);font-family:var(--dsw-font-family,system-ui);font-size:13px;line-height:1.5;overflow:hidden}",
      ".dsh-retro-list{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}",
      ".dsh-retro-toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff22);align-items:center}",
      ".dsh-retro-input,.dsh-retro-select{background:var(--dsw-alias-bg-soft,#1a1f29);color:inherit;border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:6px;padding:4px 8px;font:inherit;min-width:0}",
      ".dsh-retro-input{flex:1 1 160px}",
      ".dsh-retro-tabs{display:flex;gap:4px}",
      ".dsh-retro-tab{background:none;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#c9ced8);border-radius:999px;padding:3px 10px;cursor:pointer;font:inherit}",
      ".dsh-retro-tab[data-active='true']{border-color:var(--dsw-alias-border-l1,#ffffff22);background:var(--dsw-alias-bg-elevated,#1a1f29);color:var(--dsw-alias-label-primary,#e6e8ee)}",
      ".dsh-retro-rows{flex:1 1 auto;overflow:auto;padding:8px 10px}",
      ".dsh-retro-row{display:flex;gap:8px;align-items:baseline;padding:7px 8px;border-radius:6px;cursor:pointer;border:1px solid transparent}",
      ".dsh-retro-row:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.05))}",
      ".dsh-retro-row[data-active='true']{background:var(--dsw-alias-bg-elevated,#1a1f29);border-color:var(--dsw-alias-border-l1,#ffffff22)}",
      ".dsh-retro-row-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-retro-mono{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;font-family:Consolas,monospace}",
      ".dsh-retro-badge{display:inline-block;padding:0 7px;border-radius:999px;font-size:10px;border:1px solid var(--dsw-alias-border-l1,#ffffff22);color:var(--dsw-alias-label-secondary,#c9ced8)}",
      ".dsh-retro-empty{color:var(--dsw-alias-label-tertiary,#8a8f98);padding:10px 4px}",
      ".dsh-retro-detail{width:420px;flex:none;border-left:1px solid var(--dsw-alias-border-l1,#ffffff22);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-elevated,#1a1f29)}",
      ".dsh-retro-detail-head{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff22)}",
      ".dsh-retro-detail-body{flex:1 1 auto;overflow:auto;padding:12px 14px}",
      ".dsh-retro-detail-foot{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#ffffff22)}",
      ".dsh-retro-btn{background:var(--dsw-alias-bg-soft,#1a1f29);color:inherit;border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}",
      ".dsh-retro-btn:hover{border-color:var(--dsw-alias-border-l2,#ffffff33)}",
      ".dsh-retro-btn[data-kind='primary']{background:var(--dsw-alias-accent,#3b82f6);border-color:transparent;color:#fff}",
      ".dsh-retro-btn[data-kind='danger']{color:var(--dsw-alias-state-error-primary,#ef4444)}",
      ".dsh-retro-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".dsh-retro-md h1{font-size:15px;margin:6px 0 8px}",
      ".dsh-retro-md h2{font-size:13px;margin:12px 0 6px;color:var(--dsw-alias-label-secondary,#c9ced8)}",
      ".dsh-retro-md h3{font-size:12px;margin:10px 0 4px;color:var(--dsw-alias-label-secondary,#c9ced8)}",
      ".dsh-retro-md p{margin:6px 0}",
      ".dsh-retro-md ul,.dsh-retro-md ol{margin:6px 0;padding-left:20px}",
      ".dsh-retro-md code{background:var(--dsw-alias-bg-soft,#1a1f29);border-radius:4px;padding:1px 4px;font-family:Consolas,monospace;font-size:12px}",
      ".dsh-retro-md pre{background:var(--dsw-alias-bg-soft,#1a1f29);border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:6px;padding:8px 10px;overflow:auto}",
      ".dsh-retro-md pre code{background:none;padding:0}",
      ".dsh-retro-md a{color:var(--dsw-alias-accent,#3b82f6);text-decoration:none}",
      ".dsh-retro-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,#ffffff22);margin:10px 0}",
      ".dsh-retro-field{display:block;margin:8px 0}",
      ".dsh-retro-field textarea{width:100%;box-sizing:border-box;min-height:56px;background:var(--dsw-alias-bg-soft,#1a1f29);color:inherit;border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:6px;padding:6px 8px;font:inherit;resize:vertical}",
      ".dsh-retro-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;background:var(--dsw-alias-accent,#3b82f6);color:#fff;border:none;border-radius:999px;padding:9px 16px;font-size:13px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);font-family:var(--dsw-font-family,system-ui)}",
      ".dsh-retro-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483002;background:var(--dsw-alias-bg-soft,#1a1f29);color:var(--dsw-alias-label-primary,#e6e8ee);border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:8px;padding:8px 14px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;font-family:var(--dsw-font-family,system-ui)}",
      ".dsh-retro-toast[data-show='true']{opacity:1}",
      ".dsh-retro-sb-icon{position:relative;display:inline-flex;align-items:center;justify-content:center}",
      ".dsh-retro-sb-badge{position:absolute;top:-4px;right:-6px;min-width:12px;height:12px;padding:0 3px;border-radius:999px;background:var(--dsw-alias-accent,#3b82f6);color:#fff;font-size:9px;line-height:12px;text-align:center;font-family:var(--dsw-font-family,system-ui)}"
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return null;
      var existing = document.getElementById(STYLE_ID);
      if (existing) return existing;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
      return style;
    }

    // ---------------------------------------------------------------------
    // [2] 安全 Markdown 渲染：解析为 React 节点，文本一律作为子节点（React 自带转义）
    // ---------------------------------------------------------------------
    var SAFE_PROTOCOLS = ["http:", "https:", "obsidian:", "mailto:"];

    /** 只放行白名单协议；无法解析或协议不允许时降级为纯文本。 */
    function safeHref(url) {
      var raw = String(url ?? "").trim();
      if (!raw) return null;
      try {
        var parsed = new URL(raw, "https://dsh.invalid");
        if (SAFE_PROTOCOLS.indexOf(parsed.protocol) === -1) return null;
        return raw;
      } catch {
        return null;
      }
    }

    /** 渲染行内语法：`code`、**bold**、[text](url)。 */
    function renderInline(text, keyPrefix) {
      var nodes = [];
      var pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
      var last = 0;
      var match;
      var index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        var token = match[0];
        if (token.startsWith("`")) {
          nodes.push(h("code", { key: `${keyPrefix}-c${index}` }, token.slice(1, -1)));
        } else if (token.startsWith("**")) {
          nodes.push(h("strong", { key: `${keyPrefix}-b${index}` }, token.slice(2, -2)));
        } else {
          var linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          var href = linkMatch ? safeHref(linkMatch[2]) : null;
          nodes.push(href
            ? h("a", { key: `${keyPrefix}-a${index}`, href: href, target: "_blank", rel: "noreferrer noopener" }, linkMatch[1])
            : (linkMatch ? `${linkMatch[1]}（${linkMatch[2]}）` : token));
        }
        last = match.index + token.length;
        index += 1;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    /** 极简块级解析：标题、列表、代码块、分割线、段落。 */
    function renderMarkdown(markdown, keyPrefix = "md") {
      var lines = String(markdown ?? "").split(/\r?\n/);
      var blocks = [];
      var paragraph = [];
      var listItems = [];
      var listOrdered = false;
      var codeLines = null;

      function flushParagraph() {
        if (paragraph.length === 0) return;
        blocks.push(h("p", { key: `${keyPrefix}-p${blocks.length}` }, renderInline(paragraph.join(" "), `${keyPrefix}-p${blocks.length}`)));
        paragraph = [];
      }
      function flushList() {
        if (listItems.length === 0) return;
        var tag = listOrdered ? "ol" : "ul";
        blocks.push(h(tag, { key: `${keyPrefix}-l${blocks.length}` }, listItems.map((item, i) => h("li", { key: `${keyPrefix}-li${i}` }, renderInline(item, `${keyPrefix}-li${i}`)))));
        listItems = [];
      }

      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (codeLines !== null) {
          if (/^```/.test(line)) {
            blocks.push(h("pre", { key: `${keyPrefix}-code${blocks.length}` }, h("code", null, codeLines.join("\n"))));
            codeLines = null;
          } else {
            codeLines.push(line);
          }
          continue;
        }
        if (/^```/.test(line)) {
          flushParagraph();
          flushList();
          codeLines = [];
          continue;
        }
        var heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading) {
          flushParagraph();
          flushList();
          var level = heading[1].length;
          blocks.push(h(`h${level}`, { key: `${keyPrefix}-h${blocks.length}` }, renderInline(heading[2], `${keyPrefix}-h${blocks.length}`)));
          continue;
        }
        if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
          flushParagraph();
          flushList();
          blocks.push(h("hr", { key: `${keyPrefix}-hr${blocks.length}` }));
          continue;
        }
        var ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
        var bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (ordered || bullet) {
          flushParagraph();
          if (listItems.length > 0 && listOrdered !== Boolean(ordered)) flushList();
          listOrdered = Boolean(ordered);
          listItems.push((ordered ?? bullet)[1]);
          continue;
        }
        if (!line.trim()) {
          flushParagraph();
          flushList();
          continue;
        }
        paragraph.push(line.trim());
      }
      if (codeLines !== null && codeLines.length > 0) {
        blocks.push(h("pre", { key: `${keyPrefix}-code-end` }, h("code", null, codeLines.join("\n"))));
      }
      flushParagraph();
      flushList();
      return blocks;
    }

    // ---------------------------------------------------------------------
    // [3] 数据层
    // ---------------------------------------------------------------------
    function createToast() {
      if (typeof document === "undefined") return { show() {}, remove() {} };
      var el = document.createElement("div");
      el.className = "dsh-retro-toast";
      document.body.appendChild(el);
      var timer = null;
      return {
        show(text) {
          el.textContent = text;
          el.dataset.show = "true";
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => { el.dataset.show = "false"; }, 1800);
        },
        remove() {
          if (timer !== null) clearTimeout(timer);
          el.remove();
        }
      };
    }

    function copyText(text, toast) {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast.show(`已复制： ${text}`),
          () => toast.show("复制失败（浏览器限制）")
        );
        return;
      }
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        toast.show(`已复制： ${text}`);
      } catch {
        toast.show("复制失败（浏览器限制）");
      }
    }

    function openObsidian(note, vaultName, toast) {
      if (!note || !vaultName || typeof window === "undefined") return;
      window.open(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(note)}`, "_blank");
      toast.show("已在 Obsidian 中打开");
    }

    /** 创建插件级数据仓：快照、详情缓存、SSE/轮询与订阅。 */
    function createDataStore() {
      var state = { snapshot: null, error: null, loading: true, rev: 0, transport: "pending" };
      var listeners = new Set();
      var eventSource = null;
      var pollTimer = null;
      var probeTimer = null;
      var detailCache = new Map();
      var disposed = false;

      function emit() {
        for (var listener of Array.from(listeners)) listener();
      }
      function patch(next) {
        state = { ...state, ...next };
        emit();
      }

      async function loadSnapshot(params = {}) {
        try {
          var query = new URLSearchParams(params).toString();
          var res = await fetch(`/retro/api${query ? `?${query}` : ""}`, { headers: { accept: "application/json" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          var data = await res.json();
          if (disposed) return;
          if (data.unchanged) return;
          patch({ snapshot: data, rev: data.rev ?? state.rev, error: null, loading: false });
        } catch (error) {
          if (disposed) return;
          patch({ error: String(error?.message ?? error), loading: false });
        }
      }

      async function loadDetail(type, id) {
        var key = `${type}:${id}`;
        try {
          var res = await fetch(`/retro/detail?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
          var data = await res.json();
          if (!res.ok || data.ok === false) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
          detailCache.set(key, data);
          emit();
          return data;
        } catch (error) {
          detailCache.set(key, { error: String(error?.message ?? error) });
          emit();
          return detailCache.get(key);
        }
      }

      function startPolling() {
        if (pollTimer !== null || disposed) return;
        var delay = typeof document !== "undefined" && document.visibilityState === "hidden" ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
        pollTimer = setTimeout(async () => {
          pollTimer = null;
          await loadSnapshot({ sinceRev: String(state.rev) });
          startPolling();
        }, delay);
      }

      function startEvents() {
        if (disposed || typeof EventSource === "undefined") { patch({ transport: "polling" }); startPolling(); return; }
        try {
          eventSource = new EventSource("/retro/events");
        } catch {
          patch({ transport: "polling" });
          startPolling();
          return;
        }
        // 15 秒内没有收到任何字节即判定被缓冲，关闭并降级为轮询。
        probeTimer = setTimeout(() => {
          probeTimer = null;
          if (state.transport === "pending") {
            eventSource?.close();
            eventSource = null;
            patch({ transport: "polling" });
            startPolling();
          }
        }, SSE_PROBE_MS);
        eventSource.onmessage = (event) => {
          if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null; }
          try {
            var payload = JSON.parse(event.data);
            if (payload.rev === state.rev) return;
            patch({ transport: "sse", rev: payload.rev ?? state.rev });
            loadSnapshot({});
          } catch { /* 忽略无法解析的帧 */ }
        };
        eventSource.onerror = () => {
          eventSource?.close();
          eventSource = null;
          if (disposed) return;
          patch({ transport: "polling" });
          startPolling();
        };
      }

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getState: () => state,
        getDetail: (type, id) => detailCache.get(`${type}:${id}`),
        loadSnapshot,
        loadDetail,
        start() { loadSnapshot({}); startEvents(); },
        stop() {
          disposed = true;
          if (eventSource) { eventSource.close(); eventSource = null; }
          if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
          if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null; }
          listeners.clear();
        }
      };
    }

    /** 订阅数据仓的 Hook。 */
    function useData(store) {
      var force = React.useState(0);
      var setTick = force[1];
      React.useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);
      return store.getState();
    }

    // ---------------------------------------------------------------------
    // [4] 组件
    // ---------------------------------------------------------------------
    function Markdown({ text }) {
      return h("div", { className: "dsh-retro-md" }, renderMarkdown(text));
    }

    function RetroIcon({ size, active, badge }) {
      var px = size || 16;
      var icon = h("svg", {
        width: px, height: px, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false",
        style: { color: active ? "var(--dsw-alias-label-primary,#e6e8ee)" : "currentColor" }
      },
        h("path", { d: "M3 2.5h10v11H3z", fill: "none", stroke: "currentColor", strokeWidth: "1.2" }),
        h("path", { d: "M5.5 6h5M5.5 8.5h5M5.5 11h3", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round" })
      );
      if (!badge) return icon;
      // 角标自绘：宿主侧边栏只渲染图标组件本身，不提供角标座位。
      return h("span", { className: "dsh-retro-sb-icon" }, icon,
        h("span", { className: "dsh-retro-sb-badge" }, badge > 99 ? "99+" : String(badge)));
    }

    function StatusBadge({ status }) {
      return h("span", { className: "dsh-retro-badge" }, status);
    }

    /** 工作台：列表 + 详情。 */
    function Workbench({ store, toast }) {
      var state = useData(store);
      var viewState = React.useState("cards");
      var view = viewState[0];
      var setView = viewState[1];
      var filterState = React.useState({ status: "drafted", q: "" });
      var filter = filterState[0];
      var setFilter = filterState[1];
      var selectedState = React.useState(null);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var draftState = React.useState({});
      var drafts = draftState[0];
      var setDrafts = draftState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var snapshot = state.snapshot;
      var writeApiEnabled = snapshot?.writeApiEnabled === true;

      // 维度变化时重新拉取（服务端过滤，避免前端全量过滤）
      React.useEffect(() => {
        if (view !== "cards") return;
        var query = { limit: String(PAGE_LIMIT) };
        if (filter.status) query.status = filter.status;
        if (filter.q.trim()) query.q = filter.q.trim();
        store.loadSnapshot(query);
      }, [store, view, filter.status, filter.q]);

      function selectCard(card) {
        setSelected({ type: "card", id: card.id });
        setDrafts({});
        store.loadDetail("card", card.id);
      }
      function selectProposal(proposal) {
        setSelected({ type: "proposal", id: proposal.id });
        store.loadDetail("proposal", proposal.id);
      }

      async function submitAction(subAction) {
        if (!selected) return;
        if (!writeApiEnabled) {
          toast.show("写接口未开启，已改用命令方式");
          return;
        }
        var detail = store.getDetail(selected.type, selected.id);
        setBusy(true);
        try {
          var res = await fetch("/retro/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "card.review",
              id: selected.id,
              subAction,
              expectedHash: detail?.contentHash ?? null,
              targetDir: drafts.targetDir || undefined,
              instruction: drafts.instruction || null
            })
          });
          var payload = await res.json();
          if (!res.ok || payload.ok === false) {
            toast.show(`操作失败：${payload?.error?.message ?? `HTTP ${res.status}`}`);
            return;
          }
          toast.show(payload.result?.message ?? "操作已完成");
          setSelected(null);
          store.loadSnapshot({});
        } catch (error) {
          toast.show(`操作失败：${String(error?.message ?? error)}`);
        } finally {
          setBusy(false);
        }
      }

      var rows = view === "cards" ? (snapshot?.page?.items ?? snapshot?.queue?.cards ?? []) : (snapshot?.queue?.proposals ?? []);

      var toolbar = h("div", { className: "dsh-retro-toolbar" },
        h("div", { className: "dsh-retro-tabs" },
          h("button", {
            className: "dsh-retro-tab", "data-active": String(view === "cards"),
            onClick: () => { setView("cards"); setSelected(null); }
          }, `卡片 ${snapshot?.stats?.draftedCards ?? 0}`),
          h("button", {
            className: "dsh-retro-tab", "data-active": String(view === "proposals"),
            onClick: () => { setView("proposals"); setSelected(null); }
          }, `提案 ${snapshot?.stats?.pendingProposals ?? 0}`)
        ),
        view === "cards" ? h("select", {
          className: "dsh-retro-select",
          value: filter.status,
          onChange: (event) => setFilter({ ...filter, status: event.target.value })
        },
          h("option", { value: "drafted" }, "待审"),
          h("option", { value: "approved" }, "已落库"),
          h("option", { value: "discarded" }, "已丢弃"),
          h("option", { value: "" }, "全部")
        ) : null,
        view === "cards" ? h("input", {
          className: "dsh-retro-input",
          placeholder: "搜索标题或内容…",
          value: filter.q,
          onChange: (event) => setFilter({ ...filter, q: event.target.value })
        }) : null,
        state.transport === "polling" ? h("span", { className: "dsh-retro-mono" }, "轮询模式") : null
      );

      var listBody;
      if (state.loading && !snapshot) {
        listBody = h("div", { className: "dsh-retro-empty" }, "加载中…");
      } else if (state.error) {
        listBody = h("div", { className: "dsh-retro-empty" }, `面板数据不可用：${state.error}`,
          h("button", { className: "dsh-retro-btn", onClick: () => store.loadSnapshot({}) }, "重试"));
      } else if (rows.length === 0) {
        listBody = h("div", { className: "dsh-retro-empty" },
          view === "cards" ? "没有符合条件的卡片。可在会话中运行 /retro draft today 生成。" : "没有待采纳提案。");
      } else {
        listBody = h("div", { className: "dsh-retro-rows" }, rows.map((row, index) => {
          var isActive = selected && selected.id === row.id;
          var title = row.title ?? row.id;
          var meta = view === "cards" ? row.status : row.kind;
          return h("div", {
            key: row.id ?? index,
            className: "dsh-retro-row",
            "data-active": String(Boolean(isActive)),
            onClick: () => (view === "cards" ? selectCard(row) : selectProposal(row))
          },
            h("span", { className: "dsh-retro-mono" }, row.id ?? ""),
            h("span", { className: "dsh-retro-row-title" }, title),
            meta ? h(StatusBadge, { status: meta }) : null
          );
        }));
      }

      var detailPanel = null;
      if (selected) {
        var detail = store.getDetail(selected.type, selected.id);
        detailPanel = h("aside", { className: "dsh-retro-detail" },
          h("div", { className: "dsh-retro-detail-head" },
            h("span", { className: "dsh-retro-mono" }, selected.id),
            h("span", { className: "dsh-retro-row-title" }, detail?.meta?.title ?? ""),
            h("button", { className: "dsh-retro-btn", onClick: () => setSelected(null) }, "关闭")
          ),
          h("div", { className: "dsh-retro-detail-body" },
            detail?.error
              ? h("div", { className: "dsh-retro-empty" }, `详情加载失败：${detail.error}`)
              : !detail
                ? h("div", { className: "dsh-retro-empty" }, "加载中…")
                : h("div", null,
                  selected.type === "proposal" && detail.meta?.targetFile
                    ? h("p", { className: "dsh-retro-mono" }, `目标文件：${detail.meta.targetFile}`)
                    : null,
                  h(Markdown, { text: detail.rawMarkdown ?? "" }),
                  selected.type === "card" && writeApiEnabled
                    ? h("label", { className: "dsh-retro-field" }, "修改意见（可选，edit 时发送）",
                      h("textarea", {
                        value: drafts.instruction ?? "",
                        onChange: (event) => setDrafts({ ...drafts, instruction: event.target.value })
                      }))
                    : null
                )
          ),
          selected.type === "card"
            ? h("div", { className: "dsh-retro-detail-foot" },
              h("button", {
                className: "dsh-retro-btn",
                onClick: () => copyText(`/retro review ${selected.id} keep`, toast)
              }, "复制落库命令"),
              h("button", {
                className: "dsh-retro-btn",
                onClick: () => copyText(`/retro review ${selected.id} discard`, toast)
              }, "复制丢弃命令"),
              detail?.meta?.note
                ? h("button", {
                  className: "dsh-retro-btn",
                  onClick: () => openObsidian(detail.meta.note, snapshot?.vaultName, toast)
                }, "在 Obsidian 打开")
                : null,
              writeApiEnabled
                ? h("button", {
                  className: "dsh-retro-btn", "data-kind": "primary", disabled: busy,
                  onClick: () => submitAction("keep")
                }, busy ? "提交中…" : "确认落库")
                : null,
              writeApiEnabled
                ? h("button", {
                  className: "dsh-retro-btn", "data-kind": "danger", disabled: busy,
                  onClick: () => submitAction("discard")
                }, "丢弃")
                : null
            )
            : h("div", { className: "dsh-retro-detail-foot" },
              h("button", {
                className: "dsh-retro-btn",
                onClick: () => copyText(`/retro adopt ${selected.id}`, toast)
              }, "复制采纳命令")
            )
        );
      }

      return h("div", { className: "dsh-retro-main" },
        h("section", { className: "dsh-retro-list" }, toolbar, listBody),
        detailPanel
      );
    }

    // ---------------------------------------------------------------------
    // [5] 挂载
    // ---------------------------------------------------------------------
    function apply(ctx) {
      if (typeof document === "undefined") return;
      var style = ensureStyle();
      var toast = createToast();
      var store = createDataStore();
      var disposed = false;

      function SidebarIcon(props) {
        var state = useData(store);
        // 角标数字来自快照：待审卡片 + 待采纳提案。
        var count = (state.snapshot?.stats?.draftedCards ?? 0) + (state.snapshot?.stats?.pendingProposals ?? 0);
        return h(RetroIcon, { size: props?.size, active: props?.active, badge: count });
      }

      function PanelBody() {
        return h(Workbench, { store, toast });
      }

      store.start();

      var slots = ctx.get("slots");
      var panelRegistered = false;
      var iconRegistered = false;
      var fab = null;
      var fabTimer = null;

      function entryReady() { return panelRegistered && iconRegistered; }
      function mountFab() {
        if (disposed || fab) return;
        fab = document.createElement("button");
        fab.className = "dsh-retro-fab";
        fab.textContent = "复盘";
        fab.title = "dsh-retro 复盘面板";
        fab.addEventListener("click", () => {
          // 浮动入口只负责把宿主切换到本插件的主面板，不另建 DOM 面板。
          var layout = ctx.get?.("layout");
          if (layout?.selectPanel) layout.selectPanel(PANEL_ID);
          else toast.show("当前宿主不支持切换面板，请使用左侧栏「复盘」入口");
        });
        document.body.appendChild(fab);
      }
      function unmountFab() {
        if (fabTimer !== null) { clearTimeout(fabTimer); fabTimer = null; }
        if (fab) { fab.remove(); fab = null; }
      }
      function maybeUnmountFab() { if (entryReady()) unmountFab(); }

      if (slots && typeof slots.inject === "function") {
        try {
          slots.inject("main", function () {
            try {
              var disposePanel = slots.register({ name: "main", key: PANEL_ID }, PanelBody);
              panelRegistered = true;
              maybeUnmountFab();
              return disposePanel;
            } catch (error) {
              panelRegistered = false;
              return undefined;
            }
          });
        } catch { panelRegistered = false; }
        try {
          slots.inject("sidebar.panellist", function () {
            try {
              var disposeIcon = slots.register({
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 5,
                label: function () { return "复盘"; }
              }, SidebarIcon);
              iconRegistered = true;
              maybeUnmountFab();
              return disposeIcon;
            } catch (error) {
              iconRegistered = false;
              return undefined;
            }
          });
        } catch { iconRegistered = false; }
      }

      if (!entryReady()) {
        if (!slots) mountFab();
        else fabTimer = setTimeout(function () {
          fabTimer = null;
          if (!entryReady()) mountFab();
        }, FAB_DELAY_MS);
      }

      // 卸载清理：数据仓（SSE/轮询）、浮动按钮、提示、样式。
      ctx.effect(function () {
        return function () {
          disposed = true;
          unmountFab();
          store.stop();
          toast.remove();
          if (style) style.remove();
        };
      }, "dsh-retro: client");
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  }
});
