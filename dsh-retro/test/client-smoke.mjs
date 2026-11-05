// 在模拟浏览器中加载客户端，验证左侧栏入口、主区域面板与浮动按钮兜底。

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

// 精简 Hook 运行时：面板组件只用到 useState / useEffect。
const hookState = [];
const hookEffects = [];
let hookIndex = 0;
const reactMock = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
    return [hookState[i], (value) => { hookState[i] = value; }];
  },
  useEffect(setup) {
    const i = hookIndex++;
    if (!hookEffects[i]) hookEffects[i] = { setup, ran: false, cleanup: undefined };
  }
};
/** 渲染一次组件并执行尚未运行的 effect；effect 只运行一次。 */
function renderComponent(component, props) {
  hookIndex = 0;
  const element = component(props ?? {});
  let rerun = false;
  for (const entry of hookEffects) {
    if (!entry || entry.ran) continue;
    entry.ran = true;
    entry.cleanup = entry.setup();
    rerun = true;
  }
  if (!rerun) return element;
  hookIndex = 0;
  return component(props ?? {});
}
/** 执行已登记的 effect 清理函数，避免轮询定时器让测试进程无法退出。 */
function disposeEffects() {
  for (const entry of hookEffects) {
    if (entry && typeof entry.cleanup === "function") entry.cleanup();
  }
}

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("ok:", msg);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exports_ = capturedDef.factory((id) => {
  if (id === "react") return reactMock;
  throw new Error("unexpected require: " + id);
});

// 场景一：左侧栏入口（DSH 0.2 的 main 面板 + sidebar.panellist 图标行）
{
  created.length = 0;
  hookState.length = 0;
  hookEffects.length = 0;
  const registered = [];
  const slotsMock = {
    // 座位已声明：inject 同步执行注册回调。
    inject(key, cb) { cb(); },
    register(spec, comp) { registered.push({ spec, comp }); return () => {}; }
  };
  const ctx = {
    get(name) { return name === "slots" ? slotsMock : undefined; },
    effect(cb) { this._disposer = cb(); }
  };
  exports_.apply(ctx);

  const main = registered.find((r) => r.spec.name === "main");
  const icon = registered.find((r) => r.spec.name === "sidebar.panellist");
  check(!!main && main.spec.key === "dsh-retro", "注册 main 面板（key=dsh-retro）");
  check(!!icon && icon.spec.id === "dsh-retro", "注册左侧栏图标条目（id=dsh-retro）");
  check(typeof icon?.spec.label === "function" && icon.spec.label() === "复盘", "侧边栏行标签为「复盘」");
  check(typeof icon?.comp === "function", "图标条目提供 React 组件");
  const iconEl = icon.comp({ size: 18, active: false });
  check(iconEl && iconEl.type === "svg", "图标渲染为内联 svg");

  const panelEl = renderComponent(main.comp, {});
  check(panelEl && panelEl.type === "div" && panelEl.props.className === "dsh-retro-main", "主区域面板容器可用");
  await wait(10);
  const filled = renderComponent(main.comp, {});
  const html = filled?.props?.dangerouslySetInnerHTML?.__html ?? "";
  check(fetchCalls >= 1, "面板渲染时请求 /retro/api");
  check(html.includes("data-copy='/retro review rc-1 keep'"), "面板渲染卡片与复制命令");
  check(html.includes("data-open='Index/06_Retro/_retro/rc-1.md'"), "面板渲染 Obsidian 打开路径");
  check(!created.some((e) => e.className === "dsh-retro-fab"), "左侧栏入口可用时不创建浮动按钮");

  // 主区域面板的点击委托与浮动面板一致。
  await wait(10);
  filled.props.onClick({ target: { closest: (sel) => (sel === "[data-open]" ? { getAttribute: () => "Index/06_Retro/_retro/rc-1.md" } : null) } });
  check(!!openedUrl && openedUrl.startsWith("obsidian://open?vault=Obsidian_Stw&file="), "点击打开生成 obsidian:// URI");
  filled.props.onClick({ target: { closest: (sel) => (sel === "[data-open]" ? null : sel === "[data-copy]" ? { getAttribute: () => "/retro review rc-1 keep" } : null) } });
  await wait(10);
  check(copiedText === "/retro review rc-1 keep", "点击条目复制命令到剪贴板");

  check(typeof ctx._disposer === "function", "effect disposer 已注册");
  disposeEffects();
  ctx._disposer();
  check(created.every((el) => el.removed), "卸载后移除面板、按钮、提示和样式");
}

// 场景二：宿主没有 slots 服务时立即启用浮动入口
{
  created.length = 0;
  const ctx = { get() { return undefined; }, effect(cb) { this._disposer = cb(); } };
  exports_.apply(ctx);
  const fab = created.find((e) => e.className === "dsh-retro-fab");
  check(!!fab, "slots 不可用时创建浮动按钮");
  fab.listeners.click[0]();
  check(created.some((e) => e.className === "dsh-retro-panel" && e.style.display === "block"), "浮动按钮打开面板");
  ctx._disposer();
}

// 场景三：座位迟迟未声明时先兜底浮动入口，座位出现后撤下
{
  created.length = 0;
  const callbacks = [];
  const slotsMock = {
    inject(key, cb) { callbacks.push({ key, cb }); },
    register(spec) { return () => {}; }
  };
  const ctx = { get(name) { return name === "slots" ? slotsMock : undefined; }, effect(cb) { this._disposer = cb(); } };
  exports_.apply(ctx);
  check(!created.some((e) => e.className === "dsh-retro-fab"), "座位未声明前不立即创建浮动按钮");
  await wait(750);
  const fab = created.find((e) => e.className === "dsh-retro-fab");
  check(!!fab, "等待后仍未注册时创建浮动按钮兜底");
  // 座位稍后声明：两个注册回调执行后撤下浮动入口。
  for (const { cb } of callbacks) cb();
  check(!!fab && fab.removed, "左侧栏入口就绪后移除浮动按钮");
  ctx._disposer();
}

// 场景四：含单引号的文件名也必须保持为完整属性值，不能插入额外 HTML 属性。
{
  created.length = 0;
  notePath = "Index/_retro/quote'onmouseover='alert(1).md";
  const ctx = { get() {}, effect(fn) { this.dispose = fn(); } };
  exports_.apply(ctx);
  const fab = created.find((el) => el.className === "dsh-retro-fab");
  fab.listeners.click[0]();
  await wait(10);
  const panel = created.find((el) => el.className === "dsh-retro-panel");
  check(panel.innerHTML.includes("quote&#39;onmouseover=&#39;alert(1).md"), "属性中的单引号经过转义");
  ctx.dispose();
  check(created.every((el) => el.removed), "卸载后移除面板、按钮、提示和样式");
}

if (failures > 0) throw new Error(`${failures} 项客户端检查失败`);
console.log("client bundle smoke: ALL PASS");
