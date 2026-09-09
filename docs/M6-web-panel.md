# M6：Web 复盘面板（dsh-retro 客户端插件）— 规划与论证

> 历史归档：本文保留 2026-08-17 的面板设计论证，不是当前安装指南。面板已经实现，当前模块、生命周期和已修复问题见 [当前架构](architecture.md) 与 [标准化记录](standardization.md)，安装见 [README](../README.md)。

> 状态：2026-08-17 定稿；v2：入口升级为**侧边栏原生挂载**（`sidebar.footer.action` slot，React 按钮），
> 浮动按钮保留为 slots 不可用时的降级路径。目标：在 DSH Web UI 内嵌实时复盘面板，
> 以**原生客户端插件**形态交付（`dsh.client` 声明 + 运行时 bundle），零前端重建。

## 1. 技术机制调研结论（源码核验，v0.1.0-rc.6）

| 机制 | 源码事实 | 对 M6 的意义 |
|---|---|---|
| 客户端插件发现 | `dsh-client-modules` 监听 `internal/plugin`，增量扫描 loader entries 中声明 `dsh.client` 的包（`package.json.dsh.client = {platform:"web", inject:[...]}`） | 包内声明即被识别，**无需任何注册** |
| Bundle 服务 | 注册 `prefix /plugins` 路由：`GET /plugins/<包名>/client.js` 直接读包 `exports["./client"]` 文件内容返回（no-cache，含 sourcemap） | **运行时 serve 源码文件，前端 dist 零重建** |
| 浏览器执行 | bundle 格式 = `window.__ModuleLoader__.load({id, factory:(require)=>{...}})`（CJS 风格，CSS 内联 `<style>` 注入）；`__ModuleLoader__` 由前端 shell 内置，`require` 可解析 react、`@deepseek-ai/dsh-client-*` 等已装载客户端模块 | **手写 CJS bundle 即可，无需 bundler/JSX 编译**（用 `React.createElement`） |
| 组合图注入 | `injectBootManifest` 把 `window.__DSH_BOOT__`（含新插件行）注入 index HTML，前端启动时拉取全部 client bundle | 浏览器**刷新页面**即可加载新插件 |
| Host 数据通道 | `dsh-host-webserver` 提供 `webServer` 服务：`register({kind:"exact"|"prefix", path, handler})`（node:http req/res） | 宿主插件注册 `GET /retro/api` 提供面板数据（同源 fetch） |
| 扫描前置条件 | `resolvePkgJson = createRequire(ctx.baseUrl)` 按 **entry 名**（包名）解析 package.json | **entry name 必须是裸包名 `dsh-retro`**（当前为相对路径，需改回；依赖 npx 缓存 junction，已存在） |

## 2. 方案论证

| 方案 | 描述 | 结论 |
|---|---|---|
| **A. 原生客户端插件**（选定） | 包内 `dsh.client` + 手写 `lib/client.js`；host 注册 `/retro/api` | ✅ 机制原生、零前端重建、同源数据、工作量可控；风险：entry 名改回裸包名 |
| B. Host 路由纯 HTML 面板 | `/retro/panel` 返回自包含 HTML（同 `/retro report`） | 备选兜底；无 shell 主题、无客户端形态，不够"原生" |
| C. 重建前端 dist 包含插件 | 需完整 checkout + vite 构建 | ❌ 不再需要（A 已覆盖），成本最高 |

**结论：A 方案。** 之前"需完整 checkout + 前端构建"的结论经源码核验为误判——`serveBundle` 是运行时读文件，客户端插件可**增量落地**。

## 3. 功能范围（v2）

- **侧边栏底部「复盘」按钮**（`sidebar.footer.action` slot，React 组件，跟随侧边栏折叠样式）；
  `ctx.get("slots")` 不可用时降级为右下角浮动按钮
- 面板内容（只读，交互确认仍走 `/retro review` 等命令——人机协作原则不变）：
  - 总览统计：卡片 / 条目 / 提案 / 发布 / 素材 / 周报次数
  - 待审队列：drafted 卡片、drafted 条目、pending 提案（非 retro-suggest）
  - 最近审计（10 条）
- 数据：打开面板时 `fetch("/retro/api")`（同源，实时快照），打开期间每 30s 自动轮询
- 样式：复用 shell CSS 变量（`--dsw-*`），深色主题一致

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| entry 名改回裸包名 `dsh-retro` 的加载回归 | 复刻 boot 验证 loader import；cache junction 失效时 README 已注明重建命令 |
| client bundle 格式不符 | 逐字对照 `dsh-client-ui-skill/lib/client.js` 模板；语法检查 + 复刻 boot 拉取验证 |
| 浏览器端 `require` 缺依赖 | 只用 `react` + `@deepseek-ai/dsh-client-ui-primitives`（已确认存在于模块表） |
| `webServer` 在非 web profile 缺失 | 可选注入（`ctx.inject` 模式），缺失时跳过路由注册（面板 API 不可用，其余功能不受影响） |
| UI 挂载点（slot 系统复杂度） | v1 用浮动面板（挂 document.body，零 slot 依赖）；后续可升级 sidebar slot |

## 5. 实施步骤

1. `lib/api.js`：`renderPanelApi(store)` 纯函数（面板 JSON）+ `registerPanelApi(ctx, store)`（webServer 可选注入注册 `/retro/api`）
2. `package.json`：`exports["./client"]` + `dsh.client = {platform:"web", inject:["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-primitives"]}`
3. `lib/client.js`：手写 `__ModuleLoader__.load` bundle（React.createElement，无 JSX）
4. profile `cordis.patch.yml`：entry `name` 改回 `dsh-retro`
5. 测试：`renderPanelApi` 单测；ctx-smoke 扩展（webServer stub 验证注册）；client.js 语法检查
6. 复刻 boot 验证：`/plugins/dsh-retro/client.js` 与 `/retro/api` 可访问
7. README / PLAN 更新，提交推送

## 6. 验收标准

- [ ] 复刻 boot 中 `GET /retro/api` 返回含卡片/条目/提案/审计的 JSON
- [ ] `GET /plugins/dsh-retro/client.js` 返回 bundle（text/javascript）
- [ ] 用户刷新 DSH Web 页面后出现"复盘"浮动按钮，打开显示真实数据
- [ ] 既有 40 项测试全绿（新增 api/注册测试）
