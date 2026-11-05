// 客户端由 dsh-client-modules 在 /plugins/dsh-retro/client.js 提供，
// 使用宿主 __ModuleLoader__ 的工厂协议加载，无需额外打包器。
// 面板通过 DOM 和 /retro/api 展示数据，优先使用原生侧边栏插槽，
// 插槽不可用时使用浮动按钮。
window.__ModuleLoader__.load({
  id: "dsh-retro",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 不声明强制客户端依赖；挂载时探测 slots，不可用则启用浮动入口。
    var inject = [];

    var React = require("react");

    var PANEL_CSS = [
      ".dsh-retro-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;background:var(--dsw-alias-accent,#3b82f6);color:#fff;border:none;border-radius:999px;padding:9px 16px;font-size:13px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);font-family:var(--dsw-font-family,system-ui)}",
      ".dsh-retro-fab:hover{filter:brightness(1.1)}",
      ".dsh-retro-panel{display:none;position:fixed;right:16px;bottom:60px;z-index:2147483001;width:430px;max-height:72vh;overflow:auto;background:var(--dsw-alias-bg-base,#161a22);color:var(--dsw-alias-label-primary,#e6e8ee);border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:12px;padding:14px 16px;box-shadow:0 10px 36px rgba(0,0,0,.45);font-family:var(--dsw-font-family,system-ui);font-size:13px;line-height:1.5}",
      ".dsh-retro-panel h2{margin:10px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary,#c9ced8)}",
      ".dsh-retro-panel h2:first-child{margin-top:0}",
      ".dsh-retro-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:4px}",
      ".dsh-retro-stat{background:var(--dsw-alias-bg-soft,#1a1f29);border:1px solid var(--dsw-alias-border-l1,#ffffff12);border-radius:8px;padding:8px 10px}",
      ".dsh-retro-stat b{display:block;font-size:18px}",
      ".dsh-retro-stat span{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}",
      ".dsh-retro-item{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff0d)}",
      ".dsh-retro-item:last-child{border-bottom:none}",
      ".dsh-retro-mono{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;font-family:Consolas,monospace}",
      ".dsh-retro-empty{color:var(--dsw-alias-label-tertiary,#8a8f98);padding:6px 0}",
      ".dsh-retro-badge{display:inline-block;padding:0 7px;border-radius:999px;font-size:10px;border:1px solid var(--dsw-alias-border-l1,#ffffff22);color:var(--dsw-alias-label-secondary,#c9ced8)}",
      ".dsh-retro-audit{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
      ".dsh-retro-item.dsh-retro-clickable{cursor:pointer}",
      ".dsh-retro-item.dsh-retro-clickable:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(255,255,255,.05))}",
      ".dsh-retro-open{background:none;border:none;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;font-size:12px;padding:0 4px;margin-left:auto;flex:none}",
      ".dsh-retro-open:hover{color:var(--dsw-alias-label-primary,#e6e8ee)}",
      ".dsh-retro-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483002;background:var(--dsw-alias-bg-soft,#1a1f29);color:var(--dsw-alias-label-primary,#e6e8ee);border:1px solid var(--dsw-alias-border-l1,#ffffff22);border-radius:8px;padding:8px 14px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;transition:opacity .2s;pointer-events:none;font-family:var(--dsw-font-family,system-ui)}",
      ".dsh-retro-toast.dsh-retro-toast-show{opacity:1}",
      // 主区域面板（左侧栏入口）：复用统计与列表样式，只补充容器与标题。
      ".dsh-retro-main{height:100%;overflow:auto;padding:16px 18px;color:var(--dsw-alias-label-primary,#e6e8ee);font-family:var(--dsw-font-family,system-ui);font-size:13px;line-height:1.5}",
      ".dsh-retro-main h2{margin:12px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary,#c9ced8)}",
      ".dsh-retro-main h2:first-child{margin-top:0}"
    ].join("");

    function apply(ctx) {
      if (typeof document === "undefined") return;

      if (!document.getElementById("dsh-retro-css")) {
        var style = document.createElement("style");
        style.id = "dsh-retro-css";
        style.textContent = PANEL_CSS;
        document.head.appendChild(style);
      }

      var disposed = false;
      var open = false;
      var pollTimer = null;
      var REFRESH_MS = 30000;
      var vaultName = "";
      var panel = document.createElement("div");
      panel.className = "dsh-retro-panel";
      document.body.appendChild(panel);

      function toggle() {
        if (disposed) return;
        open = !open;
        if (open) {
          panel.style.display = "block";
          refresh();
          if (pollTimer === null) pollTimer = setInterval(refresh, REFRESH_MS);
        } else {
          panel.style.display = "none";
          if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        }
      }

      function refresh() {
        if (disposed) return;
        panel.innerHTML = "<div style='opacity:.6;padding:8px'>加载中…</div>";
        fetch("/retro/api", { headers: { accept: "application/json" } })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (data) { if (!disposed) panel.innerHTML = render(data); })
          .catch(function (error) {
            if (disposed) return;
            panel.innerHTML = "<div style='color:var(--dsw-alias-state-error-primary,#ef4444)'>面板数据不可用：" + esc(error.message || error) + "</div>";
          });
      }

      function esc(v) {
        return String(v ?? "")
          .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
      }
      function when(list, empty) {
        if (!list || list.length === 0) return "<div class='dsh-retro-empty'>" + empty + "</div>";
        return list.join("");
      }
      function render(d) {
        var s = d.stats || {};
        var q = d.queue || {};
        vaultName = d.vaultName || "";
        var cards = (q.cards || []).map(function (c) {
          return item(c.id, c.title, "/retro review " + c.id + " keep", c.note, vaultName);
        });
        var entries = (q.entries || []).map(function (e) {
          return item(e.id, e.title, "/retro entry keep " + e.id, e.note, vaultName);
        });
        var proposals = (q.proposals || []).map(function (p) {
          return "<div class='dsh-retro-item dsh-retro-clickable' data-copy='/retro adopt " + esc(p.id) + "' title='点击复制采纳命令'><span class='dsh-retro-badge'>" + esc(p.kind) + "</span><span>" + esc(p.title) + "</span></div>";
        });
        var approved = (d.recentApproved || []).map(function (c) {
          return "<div class='dsh-retro-item'><span class='dsh-retro-mono'>" + esc(c.id) + "</span><span>" + esc(c.title) + "</span>" + openBtn(c.note, vaultName) + "</div>";
        });
        var audit = (d.recentAudit || []).map(function (a) {
          return "<div class='dsh-retro-item dsh-retro-audit'><span>" + new Date(a.ts).toLocaleString("zh-CN") + "</span><span>" + esc(a.actor) + "</span><span>" + esc(a.action) + " " + esc(a.target) + "</span>" + (a.ok ? "" : " ❌") + "</div>";
        });
        var lastWeekly = s.lastWeeklyCheck ? new Date(s.lastWeeklyCheck).toLocaleString("zh-CN") : "从未";
        return [
          "<div class='dsh-retro-stats'>",
          stat(s.cards ?? 0, "卡片", (s.draftedCards ?? 0) + " 待审"),
          stat(s.entries ?? 0, "条目", (s.draftedEntries ?? 0) + " 待确认"),
          stat(s.proposals ?? 0, "提案", (s.pendingProposals ?? 0) + " 待采纳"),
          stat(s.publish ?? 0, "发布", (s.publishedPosts ?? 0) + " 已发布"),
          stat(s.materials ?? 0, "素材", "累计"),
          stat(s.weeklyCount ?? 0, "周报", lastWeekly),
          "</div>",
          "<h2>待审卡片</h2>", when(cards, "无"),
          "<h2>待确认条目</h2>", when(entries, "无"),
          "<h2>待采纳提案</h2>", when(proposals, "无"),
          "<h2>最近落库</h2>", when(approved, "无"),
          "<h2>最近审计</h2>", when(audit, "无")
        ].join("");
      }
      // 可点击条目：整行复制命令 + 右侧「打开」按钮（Obsidian）
      function item(id, title, copyCmd, note, vaultName) {
        return "<div class='dsh-retro-item dsh-retro-clickable' data-copy='" + esc(copyCmd) + "' title='点击复制命令'>" +
          "<span class='dsh-retro-mono'>" + esc(id) + "</span><span>" + esc(title) + "</span>" +
          openBtn(note, vaultName) +
          "</div>";
      }
      function openBtn(note, vaultName) {
        if (!note || !vaultName) return "";
        return "<button class='dsh-retro-open' data-open='" + esc(note) + "' title='在 Obsidian 中打开'>📂</button>";
      }
      function stat(value, label, hint) {
        return "<div class='dsh-retro-stat'><b>" + esc(value) + "</b><span>" + esc(label) + " · " + esc(hint) + "</span></div>";
      }

      // 事件委托：点击复制命令 / 打开 Obsidian
      var toast = document.createElement("div");
      toast.className = "dsh-retro-toast";
      document.body.appendChild(toast);
      var toastTimer = null;
      function showToast(text) {
        if (disposed) return;
        toast.textContent = text;
        toast.classList.add("dsh-retro-toast-show");
        if (toastTimer !== null) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          toast.classList.remove("dsh-retro-toast-show");
        }, 1800);
      }
      function copyText(text) {
        var done = function () { showToast("已复制： " + text); };
        var fail = function () { showToast("复制失败（浏览器限制）"); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fail);
        } else {
          // 降级：临时 textarea
          try {
            var ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            done();
          } catch (error) { fail(); }
        }
      }
      function openObsidian(note, vaultName) {
        var url = "obsidian://open?vault=" + encodeURIComponent(vaultName) + "&file=" + encodeURIComponent(note);
        window.open(url, "_blank");
        showToast("已在 Obsidian 中打开");
      }
      // 事件委托：点击条目复制命令 / 打开 Obsidian；浮动面板与主区域面板共用。
      function handleItemClick(event) {
        var t = event && event.target;
        var openTarget = t && typeof t.closest === "function" ? t.closest("[data-open]") : null;
        if (openTarget) { openObsidian(openTarget.getAttribute("data-open"), vaultName); return; }
        var copyTarget = t && typeof t.closest === "function" ? t.closest("[data-copy]") : null;
        if (copyTarget) copyText(copyTarget.getAttribute("data-copy"));
      }
      panel.addEventListener("click", handleItemClick);

      function cleanup() {
        disposed = true;
        if (pollTimer !== null) clearInterval(pollTimer);
        if (toastTimer !== null) clearTimeout(toastTimer);
        panel.remove();
        toast.remove();
        // 只移除本次挂载创建的样式，保留其他实例已有的节点。
        if (style) style.remove();
      }

      // 左侧栏入口：DSH 0.2 的侧边栏由官方插件渲染面板行，插件只需注册
      // `main` 面板（key 为面板 id）与 `sidebar.panellist` 图标条目（id 相同），
      // 侧边栏即可渲染「复盘」行并在点击时切换主区域面板。
      var PANEL_ID = "dsh-retro";
      var FAB_DELAY_MS = 600;
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
        fab.addEventListener("click", toggle);
        document.body.appendChild(fab);
      }
      function unmountFab() {
        if (fabTimer !== null) { clearTimeout(fabTimer); fabTimer = null; }
        if (fab) { fab.remove(); fab = null; }
      }
      function maybeUnmountFab() { if (entryReady()) unmountFab(); }

      /** 左侧栏图标行：由侧边栏传入 size/active，使用内联 SVG 避免额外依赖。 */
      function RetroIcon(props) {
        var size = (props && props.size) || 16;
        return React.createElement(
          "svg",
          { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
          React.createElement("path", { d: "M3 2.5h10v11H3z", fill: "none", stroke: "currentColor", strokeWidth: "1.2" }),
          React.createElement("path", { d: "M5.5 6h5M5.5 8.5h5M5.5 11h3", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round" })
        );
      }

      /** 主区域面板：复用同一份 HTML 渲染与轮询逻辑，点击行为与浮动面板一致。 */
      function RetroPanel() {
        var state = React.useState("<div class='dsh-retro-empty'>加载中…</div>");
        var html = state[0];
        var setHtml = state[1];
        React.useEffect(function () {
          var alive = true;
          var timer = null;
          function load() {
            fetch("/retro/api", { headers: { accept: "application/json" } })
              .then(function (res) {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
              })
              .then(function (data) {
                if (!alive) return;
                vaultName = data.vaultName || "";
                setHtml(render(data));
              })
              .catch(function (error) {
                if (!alive) return;
                setHtml("<div style='color:var(--dsw-alias-state-error-primary,#ef4444)'>面板数据不可用：" + esc(error.message || error) + "</div>");
              });
          }
          load();
          timer = setInterval(load, REFRESH_MS);
          return function () { alive = false; if (timer !== null) clearInterval(timer); };
        }, []);
        return React.createElement("div", {
          className: "dsh-retro-main",
          onClick: handleItemClick,
          dangerouslySetInnerHTML: { __html: html }
        });
      }

      if (slots && typeof slots.inject === "function") {
        // slots.inject 仅在座位真正声明后才执行回调，因此用回调是否执行判断注册结果。
        try {
          slots.inject("main", function () {
            try {
              var disposePanel = slots.register({ name: "main", key: PANEL_ID }, RetroPanel);
              panelRegistered = true;
              maybeUnmountFab();
              return disposePanel;
            } catch (error) {
              panelRegistered = false;
              return undefined;
            }
          });
        } catch (error) {
          panelRegistered = false;
        }
        try {
          slots.inject("sidebar.panellist", function () {
            try {
              var disposeIcon = slots.register({
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 5,
                label: function () { return "复盘"; }
              }, RetroIcon);
              iconRegistered = true;
              maybeUnmountFab();
              return disposeIcon;
            } catch (error) {
              iconRegistered = false;
              return undefined;
            }
          });
        } catch (error) {
          iconRegistered = false;
        }
      }

      // 兜底：宿主没有侧边栏座位或注册失败时保留浮动入口；
      // 延时等待晚到的座位声明，一旦左侧栏入口就绪就撤下浮动按钮。
      if (!entryReady()) {
        if (!slots) mountFab();
        else fabTimer = setTimeout(function () {
          fabTimer = null;
          if (!entryReady()) mountFab();
        }, FAB_DELAY_MS);
      }

      ctx.effect(function () {
        return function () {
          unmountFab();
          cleanup();
        };
      }, "dsh-retro: panel");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
