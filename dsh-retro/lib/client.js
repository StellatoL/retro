// dsh-retro client bundle — served at runtime by dsh-client-modules
// (`GET /plugins/dsh-retro/client.js`), executed by the shell's __ModuleLoader__.
// Hand-written in the official bundle format: CJS-style factory, no bundler.
// Zero React dependency: the panel is plain DOM + fetch("/retro/api").
window.__ModuleLoader__.load({
  id: "dsh-retro",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var inject = ["@deepseek-ai/dsh-client-runtime"];

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
      ".dsh-retro-audit{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}"
    ].join("");

    function apply(ctx) {
      if (typeof document === "undefined") return;
      // CSS（幂等）
      if (!document.getElementById("dsh-retro-css")) {
        var style = document.createElement("style");
        style.id = "dsh-retro-css";
        style.textContent = PANEL_CSS;
        document.head.appendChild(style);
      }

      var fab = document.createElement("button");
      fab.className = "dsh-retro-fab";
      fab.textContent = "复盘";
      fab.title = "dsh-retro 复盘面板";
      var panel = document.createElement("div");
      panel.className = "dsh-retro-panel";
      document.body.appendChild(fab);
      document.body.appendChild(panel);

      var open = false;
      fab.addEventListener("click", function () {
        open = !open;
        if (open) { panel.style.display = "block"; refresh(); }
        else panel.style.display = "none";
      });

      function refresh() {
        panel.innerHTML = "<div style='opacity:.6;padding:8px'>加载中…</div>";
        fetch("/retro/api", { headers: { accept: "application/json" } })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (data) { panel.innerHTML = render(data); })
          .catch(function (error) {
            panel.innerHTML = "<div style='color:var(--dsw-alias-state-error-primary,#ef4444)'>面板数据不可用：" + esc(error.message || error) + "</div>";
          });
      }

      function esc(v) {
        return String(v ?? "")
          .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }
      function when(list, empty) {
        if (!list || list.length === 0) return "<div class='dsh-retro-empty'>" + empty + "</div>";
        return list.join("");
      }
      function render(d) {
        var s = d.stats || {};
        var q = d.queue || {};
        var cards = (q.cards || []).map(function (c) {
          return "<div class='dsh-retro-item'><span class='dsh-retro-mono'>" + esc(c.id) + "</span><span>" + esc(c.title) + "</span></div>";
        });
        var entries = (q.entries || []).map(function (e) {
          return "<div class='dsh-retro-item'><span class='dsh-retro-mono'>" + esc(e.id) + "</span><span>" + esc(e.title) + "</span></div>";
        });
        var proposals = (q.proposals || []).map(function (p) {
          return "<div class='dsh-retro-item'><span class='dsh-retro-badge'>" + esc(p.kind) + "</span><span>" + esc(p.title) + "</span></div>";
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
          "<h2>最近审计</h2>", when(audit, "无")
        ].join("");
      }
      function stat(value, label, hint) {
        return "<div class='dsh-retro-stat'><b>" + esc(value) + "</b><span>" + esc(label) + " · " + esc(hint) + "</span></div>";
      }

      ctx.effect(function () {
        return function () {
          fab.remove();
          panel.remove();
        };
      }, "dsh-retro: panel");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
