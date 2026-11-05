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
    // 面板视图：卡片/提案走队列，其余走 resource 列表。labelKey 供中英文词条表解析。
    var VIEWS = [
      { key: "cards", labelKey: "view.cards" },
      { key: "proposals", labelKey: "view.proposals" },
      { key: "materials", labelKey: "view.materials" },
      { key: "weekly", labelKey: "view.weekly" },
      { key: "blog", labelKey: "view.blog" },
      { key: "entries", labelKey: "view.entries" }
    ];

    // ---------------------------------------------------------------------
    // [1.5] 界面文案：中英双词典；按浏览器语言惰性选择（测试可切换）
    // ---------------------------------------------------------------------
    var TEXT_ZH = {
      "view.cards": "卡片",
      "view.proposals": "提案",
      "view.materials": "素材",
      "view.weekly": "周报",
      "view.blog": "博客",
      "view.entries": "经验库",
      "kind.retro": "复盘",
      "tab.list": "视图",
      "workspace.label": "工作区",
      "workspace.switched": "已切换到工作区 {id}",
      "filter.searchPlaceholder": "搜索标题或内容…",
      "filter.drafted": "待审",
      "filter.approved": "已落库",
      "filter.discarded": "已丢弃",
      "filter.all": "全部",
      "action.batchAdopt": "批量采纳 {count}",
      "action.adopting": "采纳中…",
      "transport.polling": "轮询模式",
      "transport.sse": "实时推送",
      "transport.pending": "连接中",
      "insight.rate": "采纳率 {rate}%",
      "insight.funnel": "素材 {captured} → 卡片 {cards} → 落库 {approved}",
      "state.loading": "加载中…",
      "state.unavailable": "面板数据不可用：{message}",
      "state.retry": "重试",
      "state.emptyCards": "没有符合条件的卡片。可在会话中运行 /retro draft today 生成。",
      "state.emptyProposals": "没有待采纳提案。",
      "state.detailFailed": "详情加载失败：{message}",
      "state.noChanges": "没有可保存的修改",
      "detail.close": "关闭",
      "detail.actions": "行动项",
      "detail.lessons": "关键经验",
      "detail.saving": "保存中…",
      "detail.save": "保存修改到暂存区",
      "detail.target": "目标文件：{path}",
      "detail.targetUnknown": "（未知类型）",
      "detail.targetMissing": "目标文件尚不存在，采纳时会新建",
      "detail.duplicate": "⚠️ 与 {id}「{title}」相似度 {similarity}",
      "detail.previewHeading": "将追加的内容",
      "detail.blogMeta": "slug：{slug} · {state}",
      "detail.blogDraft": "草稿",
      "detail.blogPublished": "已发布",
      "detail.blogReady": "预检通过：可以发布",
      "detail.blogBlocked": "预检未通过：缺失 {count} 个本地图片",
      "action.copyKeep": "复制落库命令",
      "action.copyDiscard": "复制丢弃命令",
      "action.openObsidian": "在 Obsidian 打开",
      "action.confirmKeep": "确认落库",
      "action.submitting": "提交中…",
      "action.discard": "丢弃",
      "action.copyPublish": "复制发布命令",
      "action.copyEntryKeep": "复制沉淀命令",
      "action.adoptCurrent": "采纳此提案",
      "action.copyAdopt": "复制采纳命令",
      "action.copyDiscardDuplicate": "复制丢弃重复项",
      "palette.label": "复盘命令面板",
      "palette.placeholder": "搜索或跳转…（Esc 关闭）",
      "palette.switchView": "切换到 {label}",
      "toast.copied": "已复制： {text}",
      "toast.copyFailed": "复制失败（浏览器限制）",
      "toast.opened": "已在 Obsidian 中打开",
      "toast.writeDisabled": "写接口未开启，已改用命令方式",
      "toast.writeDisabledSave": "写接口未开启：请复制命令后在会话中执行",
      "toast.failed": "操作失败：{message}",
      "toast.done": "操作已完成",
      "toast.saved": "已保存到暂存区",
      "toast.adopted": "已采纳",
      "toast.noLayout": "当前宿主不支持切换面板，请使用左侧栏「复盘」入口"
    };

    var TEXT_EN = {
      "view.cards": "Cards",
      "view.proposals": "Proposals",
      "view.materials": "Materials",
      "view.weekly": "Weekly",
      "view.blog": "Blog",
      "view.entries": "Experience",
      "kind.retro": "Retro",
      "tab.list": "Views",
      "workspace.label": "Workspace",
      "workspace.switched": "Switched to workspace {id}",
      "filter.searchPlaceholder": "Search title or content…",
      "filter.drafted": "Drafted",
      "filter.approved": "Approved",
      "filter.discarded": "Discarded",
      "filter.all": "All",
      "action.batchAdopt": "Adopt {count}",
      "action.adopting": "Adopting…",
      "transport.polling": "Polling",
      "transport.sse": "Live",
      "transport.pending": "Connecting",
      "insight.rate": "Adoption {rate}%",
      "insight.funnel": "Materials {captured} → Cards {cards} → Saved {approved}",
      "state.loading": "Loading…",
      "state.unavailable": "Panel data unavailable: {message}",
      "state.retry": "Retry",
      "state.emptyCards": "No matching cards. Run /retro draft today in a session to create one.",
      "state.emptyProposals": "No pending proposals.",
      "state.detailFailed": "Failed to load detail: {message}",
      "state.noChanges": "Nothing to save",
      "detail.close": "Close",
      "detail.actions": "Action items",
      "detail.lessons": "Key lessons",
      "detail.saving": "Saving…",
      "detail.save": "Save to staging",
      "detail.target": "Target file: {path}",
      "detail.targetUnknown": "(unknown kind)",
      "detail.targetMissing": "Target file does not exist yet; adopting will create it",
      "detail.duplicate": "⚠️ Similar to {id} “{title}” ({similarity})",
      "detail.previewHeading": "Will be appended",
      "detail.blogMeta": "slug: {slug} · {state}",
      "detail.blogDraft": "draft",
      "detail.blogPublished": "published",
      "detail.blogReady": "Checks passed: ready to publish",
      "detail.blogBlocked": "Checks failed: {count} local image(s) missing",
      "action.copyKeep": "Copy keep command",
      "action.copyDiscard": "Copy discard command",
      "action.openObsidian": "Open in Obsidian",
      "action.confirmKeep": "Keep",
      "action.submitting": "Submitting…",
      "action.discard": "Discard",
      "action.copyPublish": "Copy publish command",
      "action.copyEntryKeep": "Copy promote command",
      "action.adoptCurrent": "Adopt proposal",
      "action.copyAdopt": "Copy adopt command",
      "action.copyDiscardDuplicate": "Copy discard-duplicate",
      "palette.label": "Retro command palette",
      "palette.placeholder": "Search or jump… (Esc to close)",
      "palette.switchView": "Switch to {label}",
      "toast.copied": "Copied: {text}",
      "toast.copyFailed": "Copy failed (browser restriction)",
      "toast.opened": "Opened in Obsidian",
      "toast.writeDisabled": "Write API disabled; use the copy command instead",
      "toast.writeDisabledSave": "Write API disabled: copy the command and run it in a session",
      "toast.failed": "Action failed: {message}",
      "toast.done": "Done",
      "toast.saved": "Saved to staging",
      "toast.adopted": "Adopted",
      "toast.noLayout": "This host cannot switch panels; use the sidebar entry"
    };

    /** 当前界面语言：浏览器语言以 zh 开头时用中文，其余用英文；缺失时回落中文。 */
    function currentLang() {
      try {
        var lang = typeof navigator !== "undefined" ? (navigator.language || (navigator.languages && navigator.languages[0])) : "";
        return String(lang || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
      } catch {
        return "zh";
      }
    }

    /** 词条查找并替换 {name} 占位符；缺失时回落到中文词条再回落到 key。 */
    function t(key, params) {
      var dict = currentLang() === "en" ? TEXT_EN : TEXT_ZH;
      var template = dict[key] ?? TEXT_ZH[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
    }

    // ---------------------------------------------------------------------
    // [1] 样式：只使用宿主 --dsw-alias-* 语义 token，不写死颜色
    // ---------------------------------------------------------------------
    var STYLE_ID = "dsh-retro-styles";
    var PANEL_CSS = [
      ".dsh-retro-main{position:relative;height:100%;display:flex;gap:0;color:var(--dsw-alias-label-primary,#e6e8ee);font-family:var(--dsw-font-family,system-ui);font-size:13px;line-height:1.5;overflow:hidden}",
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
      ".dsh-retro-sb-badge{position:absolute;top:-4px;right:-6px;min-width:12px;height:12px;padding:0 3px;border-radius:999px;background:var(--dsw-alias-accent,#3b82f6);color:#fff;font-size:9px;line-height:12px;text-align:center;font-family:var(--dsw-font-family,system-ui)}",
      ".dsh-retro-palette{position:absolute;top:46px;left:16px;right:16px;z-index:5;background:var(--dsw-alias-bg-elevated,#1a1f29);border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:8px;padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.35)}",
      ".dsh-retro-palette-list{margin-top:8px;max-height:280px;overflow:auto}"
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

    /** 从卡片正文中取出指定小节正文，供内联编辑预填。 */
    var SECTION_ALIASES = {
      actions: ["行动项"],
      lessons: ["关键经验", "经验"]
    };

    function extractSection(markdown, key) {
      var aliases = SECTION_ALIASES[key];
      if (!aliases) return "";
      var lines = String(markdown ?? "").split(/\r?\n/);
      var start = -1;
      for (var i = 0; i < lines.length; i += 1) {
        var heading = /^##\s+(.+)$/.exec(lines[i]);
        if (!heading) continue;
        var name = heading[1].trim();
        if (!aliases.some((alias) => name.includes(alias))) continue;
        start = i + 1;
        break;
      }
      if (start < 0) return "";
      var body = [];
      for (var j = start; j < lines.length; j += 1) {
        if (/^#{1,2}\s+/.test(lines[j])) break;
        body.push(lines[j]);
      }
      return body.join("\n").trim();
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
          () => toast.show(t("toast.copied", { text })),
          () => toast.show(t("toast.copyFailed"))
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
        toast.show(t("toast.copied", { text }));
      } catch {
        toast.show(t("toast.copyFailed"));
      }
    }

    function openObsidian(note, vaultName, toast) {
      if (!note || !vaultName || typeof window === "undefined") return;
      window.open(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(note)}`, "_blank");
      toast.show(t("toast.opened"));
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
      // 提案批量选择与卡片内联编辑草稿
      var choiceState = React.useState([]);
      var chosen = choiceState[0];
      var setChosen = choiceState[1];
      var editState = React.useState({ actions: "", lessons: "", answers: "" });
      var edits = editState[0];
      var setEdits = editState[1];

      var snapshot = state.snapshot;
      var writeApiEnabled = snapshot?.writeApiEnabled === true;

      // 命令面板（Ctrl/Cmd+K）：切换视图或跳转条目
      var paletteState = React.useState(false);
      var paletteOpen = paletteState[0];
      var setPaletteOpen = paletteState[1];
      var paletteQueryState = React.useState("");
      var paletteQuery = paletteQueryState[0];
      var setPaletteQuery = paletteQueryState[1];
      React.useEffect(() => {
        if (typeof document?.addEventListener !== "function") return undefined;
        function onKeyDown(event) {
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "k") {
            event.preventDefault?.();
            setPaletteOpen(true);
            return;
          }
          if (event.key === "Escape") setPaletteOpen(false);
        }
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, []);

      // 视图或筛选变化时重新拉取：卡片支持状态/关键字过滤，其余按 resource 拉列表。
      React.useEffect(() => {
        var query = { limit: String(PAGE_LIMIT) };
        if (view === "cards") {
          if (filter.status) query.status = filter.status;
          if (filter.q.trim()) query.q = filter.q.trim();
        } else if (view !== "proposals") {
          query.resource = view;
        }
        store.loadSnapshot(query);
      }, [store, view, filter.status, filter.q]);

      function selectRow(row) {
        if (!row || !row.detailType) return;
        setSelected({ type: row.detailType, id: row.id });
        setDrafts({});
        setEdits({ actions: "", lessons: "", answers: "" });
        store.loadDetail(row.detailType, row.id).then((detail) => {
          if (row.detailType !== "card" || !detail || detail.error) return;
          // 预填现有小节内容，用户改完直接保存回暂存区。
          setEdits({
            actions: extractSection(detail.rawMarkdown, "actions"),
            lessons: extractSection(detail.rawMarkdown, "lessons"),
            answers: ""
          });
        });
      }
      function toggleChosen(id) {
        setChosen(chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id]);
      }

      /** 调用写接口的统一封装：成功后刷新快照。 */
      async function postAction(payload) {
        setBusy(true);
        try {
          var res = await fetch("/retro/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
          var body = await res.json();
          if (!res.ok || body.ok === false) {
            toast.show(t("toast.failed", { message: body?.error?.message ?? `HTTP ${res.status}` }));
            return null;
          }
          store.loadSnapshot({});
          return body;
        } catch (error) {
          toast.show(t("toast.failed", { message: String(error?.message ?? error) }));
          return null;
        } finally {
          setBusy(false);
        }
      }

      async function submitAction(subAction) {
        if (!selected) return;
        if (!writeApiEnabled) {
          toast.show(t("toast.writeDisabled"));
          return;
        }
        var detail = store.getDetail(selected.type, selected.id);
        var body = await postAction({
          action: "card.review",
          id: selected.id,
          subAction,
          expectedHash: detail?.contentHash ?? null,
          instruction: drafts.instruction || null
        });
        if (!body) return;
        toast.show(body.result?.message ?? t("toast.done"));
        setSelected(null);
      }

      /** 切换工作区：仅影响路径与数据源，不触碰安全开关。 */
      async function switchWorkspace(id) {
        if (!writeApiEnabled) {
          toast.show(t("toast.writeDisabled"));
          return;
        }
        var body = await postAction({ action: "workspace.switch", id });
        if (!body) return;
        setSelected(null);
        setChosen([]);
        toast.show(t("workspace.switched", { id }));
        await store.loadSnapshot({});
      }

      /** 把内联编辑写回暂存区（只写暂存，不落库）。 */
      async function saveEdits() {
        if (!selected || selected.type !== "card") return;
        if (!writeApiEnabled) {
          toast.show(t("toast.writeDisabledSave"));
          return;
        }
        var detail = store.getDetail("card", selected.id);
        var sections = {};
        if (edits.actions.trim()) sections.actions = edits.actions;
        if (edits.lessons.trim()) sections.lessons = edits.lessons;
        if (Object.keys(sections).length === 0) {
          toast.show(t("state.noChanges"));
          return;
        }
        var body = await postAction({
          action: "card.patch",
          id: selected.id,
          expectedHash: detail?.contentHash ?? null,
          sections
        });
        if (!body) return;
        toast.show(body.result?.message ?? t("toast.saved"));
        await store.loadDetail("card", selected.id);
      }

      /** 批量采纳勾选的提案。 */
      async function adoptChosen() {
        if (chosen.length === 0) return;
        if (!writeApiEnabled) {
          copyText(chosen.map((id) => `/retro adopt ${id}`).join("\n"), toast);
          return;
        }
        var body = await postAction({ action: "proposal.adopt", ids: chosen });
        if (!body) return;
        toast.show(body.result?.message ?? t("toast.adopted"));
        setChosen([]);
        setSelected(null);
      }

      /** 单条采纳当前提案。 */
      async function adoptCurrent() {
        if (!selected || selected.type !== "proposal") return;
        if (!writeApiEnabled) {
          copyText(`/retro adopt ${selected.id}`, toast);
          return;
        }
        var body = await postAction({ action: "proposal.adopt", ids: [selected.id] });
        if (!body) return;
        toast.show(body.result?.message ?? t("toast.adopted"));
        setSelected(null);
      }

      // 统一行模型：不同视图给出 detailType，材料流无详情。
      function rowsFor(currentView) {
        var page = snapshot?.page;
        if (currentView === "cards") {
          return (page?.resource === "cards" ? page.items : (snapshot?.queue?.cards ?? []))
            .map((item) => ({ ...item, detailType: "card" }));
        }
        if (currentView === "proposals") {
          return (snapshot?.queue?.proposals ?? []).map((item) => ({ ...item, detailType: "proposal" }));
        }
        var items = page?.resource === currentView ? page.items : [];
        var detailType = currentView === "weekly" ? "card" : currentView === "blog" ? "blog" : currentView === "entries" ? "entry" : null;
        return items.map((item) => ({ ...item, detailType }));
      }
      var rows = rowsFor(view);

      var toolbar = h("div", { className: "dsh-retro-toolbar" },
        h("div", { className: "dsh-retro-tabs", role: "tablist" }, VIEWS.map((entry) => h("button", {
          key: entry.key,
          className: "dsh-retro-tab",
          role: "tab",
          "aria-selected": String(view === entry.key),
          "data-active": String(view === entry.key),
          onClick: () => { setView(entry.key); setSelected(null); }
        }, t(entry.labelKey)))),
        (snapshot?.workspaces?.length ?? 0) > 1
          ? h("select", {
            className: "dsh-retro-select",
            "aria-label": t("workspace.label"),
            value: snapshot.activeWorkspace || "",
            disabled: !writeApiEnabled || busy,
            onChange: (event) => switchWorkspace(event.target.value)
          }, snapshot.workspaces.map((item) => h("option", { key: item.id, value: item.id }, item.name)))
          : null,
        view === "cards" ? h("select", {
          className: "dsh-retro-select",
          value: filter.status,
          onChange: (event) => setFilter({ ...filter, status: event.target.value })
        },
          h("option", { value: "drafted" }, t("filter.drafted")),
          h("option", { value: "approved" }, t("filter.approved")),
          h("option", { value: "discarded" }, t("filter.discarded")),
          h("option", { value: "" }, t("filter.all"))
        ) : null,
        view === "cards" ? h("input", {
          className: "dsh-retro-input",
          placeholder: t("filter.searchPlaceholder"),
          value: filter.q,
          onChange: (event) => setFilter({ ...filter, q: event.target.value })
        }) : null,
        view === "proposals" && chosen.length > 0
          ? h("button", {
            className: "dsh-retro-btn", "data-kind": "primary", disabled: busy,
            onClick: () => adoptChosen()
          }, busy ? t("action.adopting") : t("action.batchAdopt", { count: chosen.length }))
          : null,
        state.transport === "polling" ? h("span", { className: "dsh-retro-mono" }, t("transport.polling")) : null
      );

      // 洞察条：漏斗与传输模式（数据来自 snapshot.insights，不影响 0.5.0 的 stats）
      var insights = snapshot?.insights;
      var insightsStrip = insights
        ? h("div", { className: "dsh-retro-toolbar", role: "status" },
          h("span", { className: "dsh-retro-mono" }, t("insight.rate", { rate: Math.round((insights.funnel?.adoptionRate ?? 0) * 100) })),
          h("span", { className: "dsh-retro-mono" }, t("insight.funnel", {
            captured: insights.funnel?.captured ?? 0,
            cards: insights.funnel?.cards ?? 0,
            approved: insights.funnel?.approved ?? 0
          })),
          h("span", { className: "dsh-retro-mono" },
            state.transport === "sse" ? t("transport.sse") : state.transport === "polling" ? t("transport.polling") : t("transport.pending"))
        )
        : null;

      var listBody;
      if (state.loading && !snapshot) {
        listBody = h("div", { className: "dsh-retro-empty" }, t("state.loading"));
      } else if (state.error) {
        listBody = h("div", { className: "dsh-retro-empty" }, t("state.unavailable", { message: state.error }),
          h("button", { className: "dsh-retro-btn", onClick: () => store.loadSnapshot({}) }, t("state.retry")));
      } else if (rows.length === 0) {
        listBody = h("div", { className: "dsh-retro-empty" },
          view === "cards" ? t("state.emptyCards") : t("state.emptyProposals"));
      } else {
        // 键盘可达：j/k 或方向键移动，Enter 打开详情；容器可聚焦。
        function onRowsKeyDown(event) {
          if (!rows.length) return;
          var currentIndex = rows.findIndex((row) => selected && selected.id === row.id);
          var nextIndex = currentIndex;
          if (event.key === "j" || event.key === "ArrowDown") nextIndex = Math.min(rows.length - 1, currentIndex + 1);
          else if (event.key === "k" || event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
          else if (event.key === "Enter" && currentIndex >= 0) {
            selectRow(rows[currentIndex]);
            return;
          } else if (event.key === "Escape") {
            setSelected(null);
            return;
          } else {
            return;
          }
          event.preventDefault?.();
          if (nextIndex !== currentIndex && nextIndex >= 0) selectRow(rows[nextIndex]);
        }
        listBody = h("div", {
          className: "dsh-retro-rows",
          role: "listbox",
          tabIndex: 0,
          onKeyDown: onRowsKeyDown
        }, rows.map((row, index) => {
          var isActive = selected && selected.id === row.id;
          var title = row.title ?? row.id;
          var meta = view === "cards" ? row.status : row.kind;
          var isChosen = view === "proposals" && chosen.includes(row.id);
          return h("div", {
            key: row.id ?? index,
            className: "dsh-retro-row",
            role: "option",
            "aria-selected": String(Boolean(isActive)),
            "data-active": String(Boolean(isActive)),
            onClick: () => selectRow(row)
          },
            view === "proposals"
              ? h("input", {
                type: "checkbox",
                checked: isChosen,
                onClick: (event) => event.stopPropagation(),
                onChange: () => toggleChosen(row.id)
              })
              : null,
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
            h("button", { className: "dsh-retro-btn", onClick: () => setSelected(null) }, t("detail.close"))
          ),
          h("div", { className: "dsh-retro-detail-body" },
            detail?.error
              ? h("div", { className: "dsh-retro-empty" }, t("state.detailFailed", { message: detail.error }))
              : !detail
                ? h("div", { className: "dsh-retro-empty" }, t("state.loading"))
                : h("div", null,
                  selected.type === "blog"
                    ? h("div", null,
                      h("p", { className: "dsh-retro-mono" }, t("detail.blogMeta", {
                        slug: detail.meta?.slug,
                        state: detail.meta?.draft ? t("detail.blogDraft") : t("detail.blogPublished")
                      })),
                      h("p", { className: "dsh-retro-mono" }, detail.checks?.ready
                        ? t("detail.blogReady")
                        : t("detail.blogBlocked", { count: detail.checks?.missingImages?.length ?? 0 })),
                      (detail.checks?.missingImages ?? []).length > 0
                        ? h("ul", null, detail.checks.missingImages.map((ref, index) => h("li", { key: index, className: "dsh-retro-mono" }, ref)))
                        : null,
                      h(Markdown, { text: detail.rawMarkdown ?? "" })
                    )
                    : selected.type === "entry"
                      ? h("div", null, h(Markdown, { text: detail.rawMarkdown ?? "" }))
                      : selected.type === "proposal"
                    ? h("div", null,
                      h("p", { className: "dsh-retro-mono" }, t("detail.target", { path: detail.meta?.targetFile ?? t("detail.targetUnknown") })),
                      detail.meta?.targetExists === false
                        ? h("p", { className: "dsh-retro-mono" }, t("detail.targetMissing"))
                        : null,
                      detail.meta?.duplicateOf
                        ? h("p", { className: "dsh-retro-mono" }, t("detail.duplicate", {
                          id: detail.meta.duplicateOf.id,
                          title: detail.meta.duplicateOf.title,
                          similarity: detail.meta.duplicateOf.similarity
                        }))
                        : null,
                      h("h2", null, t("detail.previewHeading")),
                      (detail.preview?.existingTail?.length ?? 0) > 0
                        ? h("pre", { className: "dsh-retro-mono" }, detail.preview.existingTail.join("\n"))
                        : null,
                      h("pre", { className: "dsh-retro-md" },
                        (detail.preview?.appendedLines ?? []).map((line, index) => h("div", { key: index }, `+ ${line}`)))
                    )
                    : h("div", null,
                      h(Markdown, { text: detail.rawMarkdown ?? "" }),
                      writeApiEnabled
                        ? h("div", null,
                          h("label", { className: "dsh-retro-field" }, t("detail.actions"),
                            h("textarea", {
                              value: edits.actions,
                              onChange: (event) => setEdits({ ...edits, actions: event.target.value })
                            })),
                          h("label", { className: "dsh-retro-field" }, t("detail.lessons"),
                            h("textarea", {
                              value: edits.lessons,
                              onChange: (event) => setEdits({ ...edits, lessons: event.target.value })
                            })),
                          h("button", {
                            className: "dsh-retro-btn", disabled: busy,
                            onClick: () => saveEdits()
                          }, busy ? t("detail.saving") : t("detail.save"))
                        )
                        : null
                    )
                )
          ),
          selected.type === "blog"
            ? h("div", { className: "dsh-retro-detail-foot" },
              h("button", {
                className: "dsh-retro-btn",
                onClick: () => copyText(`/blog publish ${selected.id}`, toast)
              }, t("action.copyPublish")))
            : selected.type === "entry"
              ? h("div", { className: "dsh-retro-detail-foot" },
                h("button", {
                  className: "dsh-retro-btn",
                  onClick: () => copyText(`/retro entry keep ${selected.id}`, toast)
                }, t("action.copyEntryKeep")))
              : selected.type === "card"
            ? h("div", { className: "dsh-retro-detail-foot" },
              h("button", {
                className: "dsh-retro-btn",
                onClick: () => copyText(`/retro review ${selected.id} keep`, toast)
              }, t("action.copyKeep")),
              h("button", {
                className: "dsh-retro-btn",
                onClick: () => copyText(`/retro review ${selected.id} discard`, toast)
              }, t("action.copyDiscard")),
              detail?.meta?.note
                ? h("button", {
                  className: "dsh-retro-btn",
                  onClick: () => openObsidian(detail.meta.note, snapshot?.vaultName, toast)
                }, t("action.openObsidian"))
                : null,
              writeApiEnabled
                ? h("button", {
                  className: "dsh-retro-btn", "data-kind": "primary", disabled: busy,
                  onClick: () => submitAction("keep")
                }, busy ? t("action.submitting") : t("action.confirmKeep"))
                : null,
              writeApiEnabled
                ? h("button", {
                  className: "dsh-retro-btn", "data-kind": "danger", disabled: busy,
                  onClick: () => submitAction("discard")
                }, t("action.discard"))
                : null
            )
            : h("div", { className: "dsh-retro-detail-foot" },
              h("button", {
                className: "dsh-retro-btn",
                onClick: adoptCurrent
              }, writeApiEnabled ? t("action.adoptCurrent") : t("action.copyAdopt")),
              detail?.meta?.duplicateOf
                ? h("button", {
                  className: "dsh-retro-btn",
                  onClick: () => copyText(`/retro review ${detail.meta.duplicateOf.id} discard`, toast)
                }, t("action.copyDiscardDuplicate"))
                : null
            )
        );
      }

      // 命令面板：切换视图 + 跳转当前列表条目（Ctrl/Cmd+K）
      var paletteNode = null;
      if (paletteOpen) {
        var query = paletteQuery.trim().toLowerCase();
        var commands = VIEWS.map((entry) => ({
          key: `view-${entry.key}`,
          label: t("palette.switchView", { label: t(entry.labelKey) }),
          run: () => { setView(entry.key); setSelected(null); setPaletteOpen(false); }
        }));
        for (const row of rows.slice(0, 30)) {
          commands.push({
            key: `row-${row.id}`,
            label: String(row.title ?? row.id ?? ""),
            run: () => { selectRow(row); setPaletteOpen(false); }
          });
        }
        var visible = commands
          .filter((command) => !query || command.label.toLowerCase().includes(query))
          .slice(0, 12);
        paletteNode = h("div", { className: "dsh-retro-palette", role: "dialog", "aria-modal": "true", "aria-label": t("palette.label") },
          h("input", {
            className: "dsh-retro-input",
            placeholder: t("palette.placeholder"),
            value: paletteQuery,
            onChange: (event) => setPaletteQuery(event.target.value)
          }),
          h("div", { className: "dsh-retro-palette-list" }, visible.map((command) => h("div", {
            key: command.key,
            className: "dsh-retro-row",
            role: "button",
            onClick: command.run
          }, command.label)))
        );
      }

      return h("div", { className: "dsh-retro-main" },
        h("section", { className: "dsh-retro-list" }, toolbar, insightsStrip, listBody),
        detailPanel,
        paletteNode
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
        fab.textContent = t("kind.retro");
        fab.title = `dsh-retro ${t("kind.retro")}`;
        fab.addEventListener("click", () => {
          // 浮动入口只负责把宿主切换到本插件的主面板，不另建 DOM 面板。
          var layout = ctx.get?.("layout");
          if (layout?.selectPanel) layout.selectPanel(PANEL_ID);
          else toast.show(t("toast.noLayout"));
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
                label: function () { return t("kind.retro"); }
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
