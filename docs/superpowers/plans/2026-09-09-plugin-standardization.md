# retro 插件标准化实施计划

> 执行要求：使用 executing-plans 技能逐项实施，以复选框记录实际完成状态。

**目标：** 将 retro 整理为可从 GitHub 仓库根目录安装、符合 DSH 插件契约且有可重复验证方式的开源插件；完成后提交并推送到 StellatoL/retro。代码注释使用中文。

**架构：** 保留 `dsh-retro/lib/` 的采集、提炼、沉淀、进化、发布与面板模块，以及现有 profile 指向 `dsh-retro/` 的本地链接。仓库根目录新增正式 npm 包入口，复用现有源码、技能与 bundle patch；子目录保留兼容安装清单。以 DSH 官方已安装版本 `0.1.2-rc.1` 的 README、类型声明和运行时代码为本轮可复核依据。

**技术栈：** Node.js 22、ES modules、Cordis、DSH、Node 内置测试框架、npm、GitHub Actions；不增加前端构建链。

---

## 请求与证据范围

- 用户要求：详细阅读架构、功能、提交历史，参考官方文档和 `dsh-plugin` 开源形式，标准化插件并上传原仓库，注释中文。
- 当前基线：`main`，`eaa4542`，完整历史共 19 次提交；未跟踪的 `.serena/` 是原有本地文件。
- 官方依据：`@deepseek-ai/dsh/README.zh.md` 和 CLI `runPlugin/reconcilePlugins`、`dsh-base/package.json`、`dsh-client-modules`、`dsh-tools`、`dsh-session`、`dsh-skill-filesystem`。
- 原始实现测试：47 项 Node 测试通过；宿主冒烟通过；客户端冒烟在子包目录通过，在仓库根目录失败。原有测试未验证工具输出的 DSH 运行时契约。
- 已在线读取官方快速开始、上游 README、插件开发/发布/工具指南、GitHub topic 与社区插件清单；SSH 远端 HEAD 与基线 `eaa4542` 一致。详细依据见 `docs/standardization.md`；运行时兼容验证仍以本机 DSH `0.1.2-rc.1` 为准。

## Task 1：根目录 npm 包与可重复开发入口

**Files:** 新建 `package.json`、`scripts/check.mjs`、`scripts/check-package.mjs`；修改 `dsh-retro/package.json`、`dsh-retro/cordis.patch.yml`、`.gitignore`；新建 `.gitattributes`、`.editorconfig`。

- [x] 根包命名 `dsh-retro`，版本 `0.3.0`，`type: module`，Node 最低版本 22；补齐 repository、homepage、bugs、license、`dsh-plugin` 关键词。
- [x] 根包入口指向 `./dsh-retro/lib/index.js`；客户端入口指向同目录 `client.js`；bundle 指向唯一的 `dsh-retro/cordis.patch.yml`。继续用裸包名 `dsh-retro` 注册。
- [x] 保留子包作为原本地安装路径的兼容入口，标记 private；两份清单的版本、运行时依赖与 DSH 客户端声明保持一致，由检查脚本防止漂移。
- [x] 依赖仅声明实际使用的 DSH/Cordis 服务；移除未使用的默认模型、用户提问依赖；按已验证的 `0.1.2-rc.1` 声明兼容范围，并固定开发验证依赖版本。
- [x] 定义 `npm test`、`npm run check`、`npm run test:package`。检查包导出、语法、清单一致性、tarball 包含 LICENSE/技能/patch，排除本地状态与测试资料。
- [x] 尝试从可用缓存生成锁文件；若无法获得完整依赖图，明确记录，不手写伪造锁文件或下载结果。

## Task 2：DSH 工具与事件契约

**Files:** 修改 `dsh-retro/lib/tools.js`、`collectors.js`、`distiller.js`、`commands.js`；新增 `dsh-retro/test/tools.test.js`；扩展 `pipeline.test.js`、`ctx-smoke.mjs`。

- [x] 先覆盖工具返回值的官方 JSON schema 校验、文本块渲染、缺失会话、已存在卡片和取消路径；在修复前确认失败。
- [x] `output.render` 返回 `[{ type: 'text', text }]`；失败/重复草稿的 nullable 字段与声明一致；工具沿用 `exec.signal`，取消后不继续写素材、卡片或草稿。
- [x] 通过独立 `ctx.on('session/disposed', ...)` 监听真实生命周期；保留 `session/event` 采集；对已复盘或已有待处理建议的会话去重。
- [x] 工具名关联失败时输出 `tool`，避免把布尔值 `false` 当名称；保留历史 callId 配对修复。
- [x] `/weekly` 处理官方 `readTitle()` 的 `{ title, ... }` 返回结构；保留字符串形式的兼容读取。
- [x] 运行相关测试，确认原有提案去重与 `runAdopt all` 回归继续通过。

## Task 3：配置与文件操作边界

**Files:** 修改 `dsh-retro/lib/config.js`、`commands.js`、`util.js`、`settler.js`、`publisher.js`；扩展 `smoke.test.js`、`pipeline.test.js`、`publisher.test.js`。

- [x] 先验证首次 `/retro config vaultPath` 后同一实例的后续命令能使用新配置；覆盖单项数组、无效类型和非正分段长度。
- [x] 成功保存配置后更新命令、工具、采集器和面板共享的 `cfg` 对象；按默认配置类型解析配置命令，拒绝无效值。
- [x] 文件路径检查拒绝空根、绝对输入、目录逃逸与受保护目录；受配置控制的暂存/经验目录也经过相同检查。
- [x] 只读白名单按规范化后的实际相对路径校验；博客缺失根目录时禁止写到当前目录，发布 slug 必须限制在文章目录中。
- [x] 修复 Windows 原子写重试成功后仍抛旧错误的问题。
- [x] 报告打开方式覆盖 Windows/macOS/Linux，使用参数数组启动，并处理浏览器启动失败的异步 error 事件；测试不启动真实浏览器。

## Task 4：技能发现与提案采纳

**Files:** 修改 `dsh-retro/skills/retro-writing/SKILL.md`、`dsh-retro/lib/evolvor.js`；扩展 `pipeline.test.js`。

- [x] 配套技能加入官方要求的 `name`、`description` frontmatter。
- [x] 回归测试先证明采纳新提案会覆盖已有规则的问题；再改为保留原正文并追加经人工确认的片段，继续生成 `.bak`。
- [x] 首次生成/更新技能时保留有效 frontmatter；不主动覆盖本机已有用户技能与 AGENTS.md。

## Task 5：客户端与 API 冒烟

**Files:** 修改 `dsh-retro/lib/client.js`、`api.js`、`report.js`、`test/client-smoke.mjs`、`test/api.test.js`、`test/report.test.js`。

- [x] 客户端测试按 `import.meta.url` 加载模块，去除工作目录假设，并在每个挂载场景完成后释放定时器与节点。
- [x] 保留 `__ModuleLoader__` 工厂协议、`dsh.client.inject: []`、侧边栏插槽与浮动按钮降级。
- [x] 单引号属性值与动态状态正确转义；卸载清理插件创建的样式、节点和计时器。
- [x] 最近落库列表取最新五项；测试顺序和不足五项的情况。
- [x] 验证面板 API 的 GET/HEAD、非读取方法拒绝与路由生命周期。

## Task 6：中文文档与开源协作资料

**Files:** 更新根 `README.md`、子包 `README.md`、`PLAN.md`、`docs/M6-web-panel.md`；新增 `docs/architecture.md`、`docs/standardization.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`.github/workflows/ci.yml`；源码和配置中的英文注释改为中文。

- [x] README 统一官方安装命令：`dsh plugin --profile web add github:StellatoL/retro`，以及仓库根目录 `dsh plugin --profile web add .`；解释 bundle 自动激活、旧版 profile 迁移和重启/刷新。
- [x] 完整列出命令、配置优先级、目录布局、运行时数据位置、Web 面板与人工确认边界。
- [x] 架构文档按当前代码描述入口、模块职责、数据流、状态转换和外部服务；历史设计文件标明已归档，消除当前指导中的过时结论。
- [x] 标准化记录列出 19 次提交的演化脉络、规范对照、具体修复与测试证据；分别记录官方本地包和已实际访问的在线资料，明确未覆盖的运行环境。
- [x] 博客兼容条件写清：`draft:true` 是否在生产排除取决于站点实现；不把某个 Astro 博客的行为宣传为所有 Astro 站点保证。
- [x] CI 在 Linux/Windows、Node 22/24 上运行静态检查、测试和打包检查；不自动发布 npm、不自动推送博客。

## Task 7：验证与上传

- [x] 在临时 DSH_HOME、临时 vault/blog 中运行完整测试；禁用真实 LLM、浏览器、博客 Git 推送。
- [x] 执行 `npm run check`、`npm test`、`npm run test:package`，检查 tarball 导出与随包资源；必要时用沙箱兼容的等价逐文件测试命令，注明执行差异。
- [x] 使用官方 DSH CLI，在独立临时 `DSH_HOME` 中离线安装 tarball，确认 bundle 自动注册及 `--dump-config` 输出中的插件行。
- [x] `git diff --check`、完整 diff 审阅、排查个人路径/运行时文件、确认 `.serena/` 不进入提交。
- [x] 联网恢复后核对用户指定网页、topic 与远端 HEAD，必要时补齐差异；只进行正常快进推送，禁止 force push。
- [x] 按用户授权提交中文说明并推送 `origin/main`，读取远端 commit 验证上传。

本地 74 项测试、静态检查、两种工作目录冒烟、文档链接、CI YAML、实际 tarball 加载及官方 CLI 临时 profile 安装检查全部通过，安装包保存在 `artifacts/dsh-retro-0.3.0.tgz`。已核对在线文档与社区插件清单，标准化代码以 `0d7a0057a8ecfc141748d0c5ea6c3f3a393614bd` 推送至 `origin/main`，并通过 `git ls-remote` 确认远端提交一致。GitHub Actions 的远端运行结果未核验。
