// 客户端冒烟：左侧栏入口、主面板渲染、详情、复制命令、XSS 转义与卸载清理。
// 该测试使用最小 React/浏览器替身，验证的是"渲染出什么节点"，而不是 HTML 字符串。
import { test, after } from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器替身 -----------------------------------------------------------
function makeElement(tag) {
  const el = {
    tagName: tag,
    className: "",
    dataset: {},
    style: {},
    textContent: "",
    children: [],
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    remove() { el.removed = true; },
    appendChild(child) { el.children.push(child); return child; },
    getAttribute() { return null; },
    select() {},
    focus() {}
  };
  return el;
}

const created = [];
const documentListeners = new Map();
globalThis.document = {
  visibilityState: "visible",
  getElementById() { return null; },
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  },
  removeEventListener(type, fn) {
    const list = documentListeners.get(type) ?? [];
    documentListeners.set(type, list.filter((item) => item !== fn));
  },
  createElement(tag) {
    const el = makeElement(tag);
    created.push(el);
    return el;
  },
  head: makeElement("head"),
  body: makeElement("body"),
  execCommand() { return true; }
};

let fetched = [];
let writeApiEnabled = false;
let postedBody = null;
let workspacesList = [];
let activeWorkspace = "";
globalThis.fetch = async (url, options) => {
  fetched.push({ url: String(url), method: options?.method ?? "GET" });
  if (String(url) === "/retro/action") {
    postedBody = JSON.parse(options?.body ?? "{}");
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, rev: 9, action: postedBody.action, result: { adopted: postedBody.ids ?? [], skipped: [], message: "已采纳" } })
    };
  }
  if (String(url).startsWith("/retro/detail")) {
    const isProposal = String(url).includes("type=proposal");
    return {
      ok: true,
      status: 200,
      json: async () => isProposal
        ? {
          ok: true,
          type: "proposal",
          id: "prop-1",
          meta: { kind: "skill", title: "规则提案", targetFile: "/home/.dsh/skills/retro-writing/SKILL.md", targetExists: true, duplicateOf: null, relPath: "_proposals/prop-1.md" },
          preview: { appendedLines: ["## 规则", "- 内容"], existingTail: ["# 既有正文"], changedLines: 2 },
          rawMarkdown: ""
        }
        : {
          ok: true,
          type: "card",
          id: "rc-1",
          meta: {
            title: "草稿卡",
            status: "drafted",
            stagingPath: "rc-1.md",
            note: "Index/06_Retro/_retro/rc-1.md",
            questions: [],
            sessionIds: []
          },
          contentHash: "abcdef1234567890",
          rawMarkdown: "# 草稿卡\n\n## 行动项\n\n- 修复 X\n"
        }
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      generatedAt: new Date().toISOString(),
      rev: 7,
      writeApiEnabled,
      workspaces: workspacesList,
      activeWorkspace,
      insights: {
        funnel: { captured: 3, cards: 2, reviewed: 1, approved: 1, adoptionRate: 1 },
        trends: [{ period: "2026-W45", cardsCreated: 2, cardsApproved: 1, proposalsAdopted: 0 }],
        llmUsage: null
      },
      vaultName: "Obsidian_Stw",
      stats: { cards: 2, draftedCards: 2, approvedCards: 0, proposals: 1, pendingProposals: 1, entries: 0, draftedEntries: 0, publish: 0, publishedPosts: 0, materials: 0, weeklyCount: 0 },
      queue: {
        cards: [
          { id: "rc-1", title: "草稿卡", status: "drafted", note: "Index/06_Retro/_retro/rc-1.md" },
          { id: "rc-2", title: "<img src=x onerror=alert(1)>", status: "drafted", note: null }
        ],
        entries: [],
        proposals: [{ id: "prop-1", kind: "skill", title: "规则提案" }]
      },
      page: {
        resource: "cards",
        items: [
          { id: "rc-1", title: "草稿卡", status: "drafted", stagingPath: "rc-1.md", unresolvedQuestions: 0 },
          { id: "rc-2", title: "<img src=x onerror=alert(1)>", status: "drafted", stagingPath: "rc-2.md", unresolvedQuestions: 0 }
        ],
        nextCursor: null
      },
      recentApproved: [],
      recentAudit: []
    })
  };
};

let copiedText = null;
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (value) => { copiedText = value; } } },
  configurable: true
});
let openedUrl = null;
let captured = null;
globalThis.window = {
  __ModuleLoader__: { load(def) { captured = def; } },
  open(url) { openedUrl = url; return null; }
};

// ---- 最小 Hook 运行时（按组件保存状态，支持嵌套组件）----------------------
const hookStore = new Map();
let activeSlot = null;
function slotFor(component) {
  if (!hookStore.has(component)) hookStore.set(component, { state: [], effects: [], index: 0 });
  return hookStore.get(component);
}
const reactMock = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
  useState(initial) {
    const slot = activeSlot;
    const index = slot.index++;
    if (!(index in slot.state)) slot.state[index] = typeof initial === "function" ? initial() : initial;
    return [slot.state[index], (value) => { slot.state[index] = value; }];
  },
  useEffect(setup) {
    const slot = activeSlot;
    const index = slot.index++;
    if (!slot.effects[index]) slot.effects[index] = { setup, ran: false };
  }
};

function renderComponent(component, props) {
  const slot = slotFor(component);
  const previous = activeSlot;
  activeSlot = slot;
  slot.index = 0;
  let element = component(props ?? {});
  slot.index = 0;
  let ranAny = false;
  for (const effect of slot.effects) {
    if (!effect || effect.ran) continue;
    effect.ran = true;
    effect.cleanup = effect.setup();
    ranAny = true;
  }
  if (ranAny) {
    slot.index = 0;
    element = component(props ?? {});
  }
  activeSlot = previous;
  return element;
}

/** 递归展开函数组件，得到最终宿主节点树。 */
function expand(node) {
  if (node == null || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(expand).filter(Boolean);
  if (typeof node === "string" || typeof node === "number") return node;
  if (typeof node.type === "function") return expand(renderComponent(node.type, node.props));
  return { type: node.type, props: node.props ?? {}, children: (node.children ?? []).map(expand).filter(Boolean) };
}

function walk(node, visit) {
  if (node == null || typeof node === "string") return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  visit(node);
  (node.children ?? []).forEach((child) => walk(child, visit));
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children ?? []).map(textOf).join("");
}

function findByClass(tree, className) {
  const hits = [];
  walk(tree, (node) => { if (node.props?.className === className) hits.push(node); });
  return hits;
}

// ---- 载入客户端模块 -------------------------------------------------------
await import(new URL("../lib/client.js", import.meta.url));
assert.ok(captured, "客户端未调用 __ModuleLoader__.load");
const clientExports = captured.factory((name) => {
  assert.equal(name, "react");
  return reactMock;
});
assert.equal(typeof clientExports.apply, "function");
assert.equal(clientExports.inject.length, 0, "客户端不应声明强制注入");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 执行所有组件 effect 的清理函数（模拟 React 卸载）。 */
function disposeAllEffects() {
  for (const slot of hookStore.values()) {
    for (const effect of slot.effects) {
      if (effect && typeof effect.cleanup === "function") {
        try { effect.cleanup(); } catch { /* 已释放 */ }
        effect.cleanup = undefined;
      }
    }
  }
}

function makeCtx({ slots, layout } = {}) {
  return {
    get(name) {
      if (name === "slots") return slots;
      if (name === "layout") return layout;
      return undefined;
    },
    effect(cb) {
      const disposer = cb();
      this._dispose = () => {
        disposer?.();
        disposeAllEffects();
      };
    }
  };
}

// 所有用例共享的挂载登记：即使断言失败也会在收尾时释放定时器与通道。
const mounted = [];
after(() => {
  for (const ctx of mounted) {
    try { ctx._dispose?.(); } catch { /* 已释放 */ }
  }
});
function startClient(t, options) {
  // 每个用例独立 Hook 状态：组件函数在同一模块内复用，effect 只跑一次。
  disposeAllEffects();
  hookStore.clear();
  activeSlot = null;
  const ctx = makeCtx(options);
  clientExports.apply(ctx);
  mounted.push(ctx);
  if (typeof t?.after === "function") t.after(() => ctx._dispose?.());
  return ctx;
}

test("左侧栏注册 main 与 sidebar.panellist，零 innerHTML 渲染卡片与详情", async (t) => {
  created.length = 0;
  fetched = [];
  copiedText = null;
  const registered = [];
  const slots = {
    inject(key, cb) { cb(); },
    register(spec, component) { registered.push({ spec, component }); return () => {}; }
  };
  const ctx = startClient(t, { slots });
  await wait(10);

  const main = registered.find((row) => row.spec.name === "main");
  const icon = registered.find((row) => row.spec.name === "sidebar.panellist");
  assert.ok(main && main.spec.key === "dsh-retro");
  assert.ok(icon && icon.spec.id === "dsh-retro");
  assert.equal(icon.spec.label(), "复盘");

  // 图标：外层是自绘角标容器，内部是 svg
  const iconTree = expand({ type: icon.component, props: { size: 18, active: false }, children: [] });
  let svgCount = 0;
  walk(iconTree, (node) => { if (node.type === "svg") svgCount += 1; });
  assert.ok(svgCount >= 1, "图标必须渲染 svg");

  // 主面板：列表渲染 + 无 innerHTML 注入点
  const tree = expand({ type: main.component, props: {}, children: [] });
  assert.equal(findByClass(tree, "dsh-retro-main").length, 1);
  // 六个视图入口：卡片 / 提案 / 素材 / 周报 / 博客 / 经验库
  assert.equal(findByClass(tree, "dsh-retro-tab").length, 6);
  const rows = findByClass(tree, "dsh-retro-row");
  assert.equal(rows.length, 2);
  assert.ok(textOf(tree).includes("草稿卡"));
  let innerHtmlNodes = 0;
  walk(tree, (node) => { if (node.props && "dangerouslySetInnerHTML" in node.props) innerHtmlNodes += 1; });
  assert.equal(innerHtmlNodes, 0, "不得使用 dangerouslySetInnerHTML");

  // XSS 载荷必须作为纯文本子节点出现，不能变成真实节点
  const xssRow = rows.find((row) => textOf(row).includes("<img src=x"));
  assert.ok(xssRow, "恶意标题应作为文本渲染");
  let injectedImg = 0;
  walk(xssRow, (node) => { if (node.type === "img") injectedImg += 1; });
  assert.equal(injectedImg, 0, "不得把标题解析成真实 img 节点");

  // 点击行 -> 打开详情并请求 /retro/detail
  await xssRow.props.onClick();
  await wait(10);
  assert.ok(fetched.some((entry) => entry.url.startsWith("/retro/detail")), "点击卡片应拉取详情");
  const detailTree = expand({ type: main.component, props: {}, children: [] });
  assert.equal(findByClass(detailTree, "dsh-retro-detail").length, 1);
  assert.ok(textOf(detailTree).includes("行动项"), "详情应渲染 Markdown 正文");

  // 复制落库命令（保留既有习惯）
  const copyButton = findByClass(detailTree, "dsh-retro-btn").find((node) => textOf(node).includes("复制落库命令"));
  assert.ok(copyButton, "详情应提供复制落库命令");
  copyButton.props.onClick();
  await wait(5);
  assert.equal(copiedText, "/retro review rc-2 keep");

  assert.ok(!created.some((el) => el.className === "dsh-retro-fab"), "左侧栏入口可用时不应创建浮动按钮");
  ctx._dispose();
});

test("宿主无 slots 时立即创建浮动入口，并能提示切换面板", async (t) => {
  created.length = 0;
  const ctx = startClient(t, {});
  const fab = created.find((el) => el.className === "dsh-retro-fab");
  assert.ok(fab, "无 slots 时应创建浮动按钮");
  fab.listeners.click[0]();
  const toast = created.find((el) => el.className === "dsh-retro-toast");
  assert.ok(toast && toast.textContent.includes("左侧栏"), "缺少 layout 时应提示使用左侧栏入口");
  ctx._dispose();
});

test("座位延迟声明时先兜底浮动入口，入口就绪后撤下", async (t) => {
  created.length = 0;
  const callbacks = [];
  const slots = {
    inject(key, cb) { callbacks.push(cb); },
    register() { return () => {}; }
  };
  const ctx = startClient(t, { slots });
  assert.ok(!created.some((el) => el.className === "dsh-retro-fab"), "座位未声明前不应立即创建浮动按钮");
  await wait(750);
  const fab = created.find((el) => el.className === "dsh-retro-fab");
  assert.ok(fab, "等待后仍未注册时应创建浮动按钮");
  for (const cb of callbacks) cb();
  assert.ok(fab.removed, "入口就绪后应移除浮动按钮");
  ctx._dispose();
});

test("卸载时清理样式、按钮与数据通道", async (t) => {
  created.length = 0;
  const slots = { inject(key, cb) { cb(); }, register() { return () => {}; } };
  const ctx = startClient(t, { slots });
  const style = created.find((el) => el.tagName === "style");
  assert.ok(style, "应注入样式表");
  ctx._dispose();
  assert.ok(style.removed, "卸载时必须移除样式");
  assert.ok(created.filter((el) => el.className === "dsh-retro-toast").every((el) => el.removed));
});

test("洞察条展示采纳率，Ctrl+K 打开命令面板并可切换视图", async (t) => {
  created.length = 0;
  writeApiEnabled = false;
  const registered = [];
  const slots = {
    inject(key, cb) { cb(); },
    register(spec, component) { registered.push({ spec, component }); return () => {}; }
  };
  const ctx = startClient(t, { slots });
  await wait(10);
  const main = registered.find((row) => row.spec.name === "main");

  let tree = expand({ type: main.component, props: {}, children: [] });
  assert.ok(textOf(tree).includes("采纳率 100%"), "洞察条应展示采纳率");

  // 触发 Ctrl+K：面板出现，包含视图命令
  const keyHandlers = documentListeners.get("keydown") ?? [];
  assert.ok(keyHandlers.length > 0, "应注册全局快捷键监听");
  keyHandlers[0]({ key: "k", ctrlKey: true, preventDefault() {} });
  tree = expand({ type: main.component, props: {}, children: [] });
  const palette = findByClass(tree, "dsh-retro-palette");
  assert.equal(palette.length, 1, "Ctrl+K 应打开命令面板");
  assert.ok(textOf(palette[0]).includes("切换到 博客"), "命令面板应包含视图切换命令");

  // Esc 关闭
  keyHandlers[0]({ key: "Escape" });
  tree = expand({ type: main.component, props: {}, children: [] });
  assert.equal(findByClass(tree, "dsh-retro-palette").length, 0, "Esc 应关闭命令面板");

  ctx._dispose();
  assert.equal((documentListeners.get("keydown") ?? []).length, 0, "卸载时必须移除快捷键监听");
});

test("界面文案随浏览器语言切换英文", async (t) => {
  created.length = 0;
  writeApiEnabled = false;
  Object.defineProperty(globalThis.navigator, "language", { value: "en-US", configurable: true });
  t.after(() => Object.defineProperty(globalThis.navigator, "language", { value: undefined, configurable: true }));
  const registered = [];
  const slots = {
    inject(key, cb) { cb(); },
    register(spec, component) { registered.push({ spec, component }); return () => {}; }
  };
  const ctx = startClient(t, { slots });
  await wait(10);
  const main = registered.find((row) => row.spec.name === "main");

  let tree = expand({ type: main.component, props: {}, children: [] });
  const tabsText = findByClass(tree, "dsh-retro-tab").map((node) => textOf(node)).join("|");
  assert.ok(tabsText.includes("Cards") && tabsText.includes("Experience"), `tabs 应为英文，实际：${tabsText}`);
  assert.ok(textOf(tree).includes("Adoption 100%"), "洞察条应为英文");

  const rows = findByClass(tree, "dsh-retro-row");
  await rows[0].props.onClick();
  await wait(10);
  tree = expand({ type: main.component, props: {}, children: [] });
  const buttons = findByClass(tree, "dsh-retro-btn").map((node) => textOf(node));
  assert.ok(buttons.includes("Copy keep command"), `应出现英文按钮，实际：${buttons.join("|")}`);
  assert.ok(buttons.includes("Open in Obsidian"));
  ctx._dispose();
});

test("多工作区时显示选择器并调用切换动作", async (t) => {
  created.length = 0;
  postedBody = null;
  writeApiEnabled = true;
  workspacesList = [
    { id: "a", name: "主库", active: true },
    { id: "b", name: "团队库", active: false }
  ];
  activeWorkspace = "a";
  t.after(() => { workspacesList = []; activeWorkspace = ""; writeApiEnabled = false; });
  const registered = [];
  const slots = {
    inject(key, cb) { cb(); },
    register(spec, component) { registered.push({ spec, component }); return () => {}; }
  };
  const ctx = startClient(t, { slots });
  await wait(10);
  const main = registered.find((row) => row.spec.name === "main");
  const tree = expand({ type: main.component, props: {}, children: [] });

  let selector = null;
  walk(tree, (node) => {
    if (node.type === "select" && node.props?.["aria-label"] === "工作区") selector = node;
  });
  assert.ok(selector, "应显示工作区选择器");
  const options = (selector.children ?? []).flat();
  assert.equal(options.length, 2);
  await selector.props.onChange({ target: { value: "b" } });
  await wait(10);
  assert.equal(postedBody?.action, "workspace.switch");
  assert.equal(postedBody?.id, "b");
  ctx._dispose();
});

test("提案视图展示追加 Diff，并可批量采纳", async (t) => {
  created.length = 0;
  fetched = [];
  postedBody = null;
  writeApiEnabled = true;
  const registered = [];
  const slots = {
    inject(key, cb) { cb(); },
    register(spec, component) { registered.push({ spec, component }); return () => {}; }
  };
  const ctx = startClient(t, { slots });
  await wait(10);
  const main = registered.find((row) => row.spec.name === "main");

  // 切到提案视图
  let tree = expand({ type: main.component, props: {}, children: [] });
  const proposalTab = findByClass(tree, "dsh-retro-tab").find((node) => textOf(node).includes("提案"));
  assert.ok(proposalTab, "应有提案视图入口");
  proposalTab.props.onClick();
  tree = expand({ type: main.component, props: {}, children: [] });

  // 打开提案详情：展示目标文件与将追加的行
  const rows = findByClass(tree, "dsh-retro-row");
  assert.equal(rows.length, 1);
  await rows[0].props.onClick();
  await wait(10);
  tree = expand({ type: main.component, props: {}, children: [] });
  const detailText = textOf(findByClass(tree, "dsh-retro-detail")[0]);
  assert.ok(detailText.includes("将追加的内容"));
  assert.ok(detailText.includes("+ ## 规则"));
  assert.ok(detailText.includes("SKILL.md"));

  // 勾选后出现批量采纳按钮，点击走写接口
  const checkbox = findByClass(tree, "dsh-retro-row")
    .map((row) => findByClass(row, "dsh-retro-row")[0])
    .filter(Boolean)[0];
  assert.ok(checkbox, "提案行存在");
  let checkNode = null;
  walk(tree, (node) => { if (node.type === "input" && node.props?.type === "checkbox") checkNode = node; });
  assert.ok(checkNode, "提案行应提供勾选框");
  checkNode.props.onChange();
  tree = expand({ type: main.component, props: {}, children: [] });
  const adoptButton = findByClass(tree, "dsh-retro-btn").find((node) => textOf(node).includes("批量采纳"));
  assert.ok(adoptButton, "勾选后应出现批量采纳按钮");
  await adoptButton.props.onClick();
  await wait(10);
  assert.ok(postedBody, "应调用写接口");
  assert.equal(postedBody.action, "proposal.adopt");
  assert.deepEqual(postedBody.ids, ["prop-1"]);

  writeApiEnabled = false;
  ctx._dispose();
});
