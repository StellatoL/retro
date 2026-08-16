// dsh-retro: client bundle smoke — execute the bundle in a mocked browser
// environment and verify BOTH mount paths (sidebar slot + floating fallback).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ---- browser mocks ----
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
globalThis.fetch = async () => {
  fetchCalls++;
  return {
    ok: true,
    json: async () => ({
      vaultName: "Obsidian_Stw",
      stats: { cards: 3, draftedCards: 1 },
      queue: {
        cards: [{ id: "rc-1", title: "草稿卡", note: "Index/06_Retro/_retro/rc-1.md" }],
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

// capture the module definition
let capturedDef = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { capturedDef = def; }
  },
  open(url) { openedUrl = url; return null; }
};
await import(pathToFileURL(path.join(process.cwd(), "lib", "client.js")).href);
if (!capturedDef) throw new Error("client bundle did not call __ModuleLoader__.load");

// react mock
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

// ---- path 1: sidebar slot ----
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
    // click toggles panel
    el.props.onClick();
    check(created.some((e) => e.className === "dsh-retro-panel" && e.style.display === "block"), "点击打开面板");
    el.props.onClick();
    check(created.some((e) => e.className === "dsh-retro-panel" && e.style.display === "none"), "再次点击关闭面板");
  }
  check(typeof registerDisposer === "function", "register 返回 disposer");
  // no fab in sidebar mode
  check(!created.some((e) => e.className === "dsh-retro-fab"), "侧边栏模式下无浮动按钮");
  check(typeof ctx._disposer === "function", "effect disposer 已注册");
  if (typeof ctx._disposer === "function") { ctx._disposer(); check(true, "disposer 可调用"); }
}

// ---- path 2: floating fallback ----
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
}

// ---- path 3: panel interactions (copy command / open in Obsidian) ----
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
  await new Promise((r) => setTimeout(r, 10)); // let fetch .then run
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

if (failures > 0) { console.error(failures + " failures"); process.exit(1); }
console.log("client bundle smoke: ALL PASS");
process.exit(0); // poll timers keep the event loop alive
