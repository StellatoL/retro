// 在模拟浏览器中加载客户端，验证侧边栏与浮动按钮两种入口。

// 浏览器环境替身
function makeElement(tag) {
  const el = {
    tagName: tag,
    className: "",
    style: {},
    textContent: "",
    title: "",
    id: "",
    children: [],
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    remove() { el.removed = true; },
    appendChild(child) { el.children.push(child); return child; }
  };
  return el;
}
const created = [];
globalThis.document = {
  getElementById() { return null; },
  createElement(tag) {
    const el = makeElement(tag);
    el.dataset = {};
    el.getAttribute = (k) => el.dataset[k] ?? null;
    el.classList = { add() {}, remove() {} };
    el.select = () => {};
    el.focus = () => {};
    created.push(el);
    return el;
  },
  head: makeElement("head"),
  body: makeElement("body"),
  execCommand() { return true; }
};
let fetchCalls = 0;
let notePath = "Index/06_Retro/_retro/rc-1.md";
globalThis.fetch = async () => {
  fetchCalls++;
  return {
    ok: true,
    json: async () => ({
      vaultName: "Obsidian_Stw",
      stats: { cards: 3, draftedCards: 1 },
      queue: {
        cards: [{ id: "rc-1", title: "草稿卡", note: notePath }],
        entries: [],
        proposals: []
      },
      recentApproved: [],
      recentAudit: []
    })
  };
};
let copiedText = null;
let openedUrl = null;
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (t) => { copiedText = t; } } },
  configurable: true
});

// 捕获客户端模块定义。
let capturedDef = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { capturedDef = def; }
  },
  open(url) { openedUrl = url; return null; }
};
await import(new URL("../lib/client.js", import.meta.url));
if (!capturedDef) throw new Error("client bundle did not call __ModuleLoader__.load");

// React 渲染替身
const reactMock = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children }; }
};
const factoryExports = capturedDef.factory((id) => {
  if (id === "react") return reactMock;
  throw new Error("unexpected require: " + id);
});

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("ok:", msg);
}

// 场景一：侧边栏插槽
{
  created.length = 0;
  let injectedHole = null;
  let registered = null;
  const slotsMock = {
    inject(hole, cb) { injectedHole = hole; this._cb = cb; },
    register(spec, comp) { registered = { spec, comp }; return () => {}; }
  };
  const ctx = {
    get(name) { return name === "slots" ? slotsMock : undefined; },
    effect(cb) { this._disposer = cb(); }
  };
  factoryExports.apply(ctx);
  check(injectedHole === "sidebar.footer.action", "slots.inject 注册到 sidebar.footer.action");
  // slots.inject 的回调在 slot 渲染时惰性调用——手动触发以模拟 sidebar 渲染
  const registerDisposer = slotsMock._cb();
  check(registered && registered.spec.name === "sidebar.footer.action", "slots.register 使用正确 slot 名");
  check(typeof registered?.comp === "function", "注册了 React 组件");
  if (registered) {
    const el = registered.comp({ wide: false });
    check(el && el.type === "button", "组件渲染 <button>");
    check(el.props.className === "dsh-retro-sidebar-btn", "按钮使用侧边栏样式类");
    // 点击按钮切换面板开关。
    el.props.onClick();
    check(created.some((e) => e.className === "dsh-retro-panel" && e.style.display === "block"), "点击打开面板");
    el.props.onClick();
    check(created.some((e) => e.className === "dsh-retro-panel" && e.style.display === "none"), "再次点击关闭面板");
  }
  check(typeof registerDisposer === "function", "register 返回 disposer");
  // 侧边栏模式下不再创建浮动按钮。
  check(!created.some((e) => e.className === "dsh-retro-fab"), "侧边栏模式下无浮动按钮");
  check(typeof ctx._disposer === "function", "effect disposer 已注册");
  if (typeof ctx._disposer === "function") { ctx._disposer(); check(true, "disposer 可调用"); }
}

// 场景二：浮动按钮降级入口
{
  created.length = 0;
  const ctx = {
    get() { return undefined; },
    effect(cb) { this._disposer = cb(); }
  };
  factoryExports.apply(ctx);
  const fab = created.find((e) => e.className === "dsh-retro-fab");
  check(!!fab, "slots 不可用时创建浮动按钮");
  if (fab && fab.listeners.click) {
    fab.listeners.click[0]();
    check(created.some((e) => e.className === "dsh-retro-panel" && e.style.display === "block"), "浮动按钮打开面板");
  }
  ctx._disposer();
}

// 场景三：复制命令与打开 Obsidian
{
  created.length = 0;
  copiedText = null;
  openedUrl = null;
  fetchCalls = 0;
  const slotsMock = {
    inject(hole, cb) { this._cb = cb; },
    register(spec, comp) { this._registered = { spec, comp }; return () => {}; }
  };
  const ctx = {
    get(name) { return name === "slots" ? slotsMock : undefined; },
    effect(cb) { this._disposer = cb(); }
  };
  factoryExports.apply(ctx);
  // 通过侧边栏按钮打开面板（toggle → refresh）
  slotsMock._cb();
  const btnEl = slotsMock._registered.comp({ wide: false });
  btnEl.props.onClick();
  const panelEl = created.find((e) => e.className === "dsh-retro-panel");
  await new Promise((r) => setTimeout(r, 10)); // 等待请求回调更新面板。
  check(fetchCalls >= 1, "面板打开时请求 /retro/api");
  check(panelEl.innerHTML.includes("data-copy='/retro review rc-1 keep'"), "卡片行携带复制命令");
  check(panelEl.innerHTML.includes("data-open='Index/06_Retro/_retro/rc-1.md'"), "卡片行携带 Obsidian 打开路径");

  // 点击「打开」→ obsidian:// URI
  const clickHandler = panelEl.listeners.click[0];
  clickHandler({ target: {
    closest: (sel) => sel === "[data-open]" ? { getAttribute: () => "Index/06_Retro/_retro/rc-1.md" } : null
  } });
  check(!!openedUrl && openedUrl.startsWith("obsidian://open?vault=Obsidian_Stw&file="), "点击打开生成 obsidian:// URI");
  check(openedUrl.includes(encodeURIComponent("Index/06_Retro/_retro/rc-1.md")), "URI 包含编码后的文件路径");

  // 点击条目 → 复制命令
  clickHandler({ target: {
    closest: (sel) => (sel === "[data-open]" ? null : sel === "[data-copy]" ? { getAttribute: () => "/retro review rc-1 keep" } : null)
  } });
  await new Promise((r) => setTimeout(r, 10));
  check(copiedText === "/retro review rc-1 keep", "点击条目复制命令到剪贴板");

  // 提案行复制
  const clickProposal = { target: { closest: (sel) => (sel === "[data-open]" ? null : sel === "[data-copy]" ? { getAttribute: () => "/retro adopt prop-9" } : null) } };
  clickHandler(clickProposal);
  await new Promise((r) => setTimeout(r, 10));
  check(copiedText === "/retro adopt prop-9", "提案行复制采纳命令");

  if (typeof ctx._disposer === "function") ctx._disposer();
}

// 含单引号的文件名也必须保持为完整属性值，不能插入额外 HTML 属性。
{
  created.length = 0;
  notePath = "Index/_retro/quote'onmouseover='alert(1).md";
  const ctx = { get() {}, effect(fn) { this.dispose = fn(); } };
  factoryExports.apply(ctx);
  const fab = created.find((el) => el.className === "dsh-retro-fab");
  fab.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const panel = created.find((el) => el.className === "dsh-retro-panel");
  check(panel.innerHTML.includes("quote&#39;onmouseover=&#39;alert(1).md"), "属性中的单引号经过转义");
  ctx.dispose();
  check(created.every((el) => el.removed), "卸载后移除面板、按钮、提示和样式");
}

if (failures > 0) throw new Error(`${failures} 项客户端检查失败`);
console.log("client bundle smoke: ALL PASS");
