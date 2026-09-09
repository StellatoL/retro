# 插件标准化记录

日期：2026-09-09。目标版本：`0.3.0`。仓库：[StellatoL/retro](https://github.com/StellatoL/retro)。

本轮从本地 `main` 的 `eaa4542` 开始，阅读了现有架构设计、14 个运行时模块、测试及截至该提交的全部 19 次提交。修改保留采集、提炼、沉淀、进化、发布的职责划分，重点解决根目录安装、DSH 接口契约、文件边界与可重复验证。

## 核验依据与范围

### 已实际读取的依据

本机官方已安装包为 DSH `0.1.2-rc.1`、Cordis `4.0.2`。以下包内资料用于接口与运行时契约验证；在线资料用于核对发布方式，两者分别记录。

| 官方包内资料 | 核验结论 |
| --- | --- |
| `@deepseek-ai/dsh/README.zh.md` | CLI profile 管理方式；bundle、profile、home、命令覆盖层的应用顺序 |
| `@deepseek-ai/dsh/lib/plugin-F7ZVfRyo.js` 的插件管理逻辑 | `dsh plugin` 转发 pnpm 参数，锚定本地安装路径，自动将含 `dsh.bundle` 的包加入 profile |
| `@deepseek-ai/dsh-base/package.json` | ESM 导出、patch 导出、`dsh.bundle.patch` 的官方示例 |
| `@deepseek-ai/dsh-client-modules` 的包声明、运行时代码与类型 | 按包名发现 `dsh.client`、`./client` 导出与模块工厂协议 |
| `@deepseek-ai/dsh-client-ui-skill` 客户端实现 | 原生插槽注册方式 |
| `@deepseek-ai/dsh-tools` 的实现与类型 | `defineTool` schema DSL、字段必填声明、可空类型、内容块输出 |
| `@deepseek-ai/dsh-session`、`dsh-session-query` 的实现与类型 | 会话销毁是独立事件，`readTitle()` 返回标题快照 |
| `@deepseek-ai/dsh-skill-filesystem` 的实现与类型 | `SKILL.md` 需包含 `name` 与 `description` 的 YAML 头部 |
| 本地 Git 提交树、原始测试与新增回归测试 | 确认历史兼容约束，验证实际缺陷与修复结果 |

开发依赖和锁文件基于本地官方缓存中的已发布包版本生成，再交给 npm 校验整理。离线执行 `npm ci --ignore-scripts` 成功安装 40 个包；没有手工虚构下载地址或完整性字段。

### 已在线核验的资料

2026-09-09 恢复联网后，实际读取了用户指定入口及相关开发文档：

| 在线资料 | 核验结论与采用方式 |
| --- | --- |
| [官方快速开始](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) | 介绍 Web 界面、模型设置与工作区；启动目录影响文件系统默认位置 |
| [DeepSeek Harness GitHub](https://github.com/deepseek-ai/deepseek-harness) | 官方入口支持 `npx @deepseek-ai/dsh web`；第三方扩展推荐使用 `dsh-plugin` 仓库主题；项目仍处于开发预览阶段 |
| [插件开发基础](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) | 采用 `name`、`inject`、`apply` 生命周期；外部资源应随上下文释放；源码绝对路径适合临时覆盖层 |
| [插件发布指南](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) | 根目录 npm 包声明 ESM 入口、分发文件与 `dsh.bundle.patch`；patch 使用裸包名；CLI 安装后自动加入 profile；`--dump-config` 可核验配置合成 |
| [工具开发指南](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool) | 工具参数使用属性级 `required`；`output.render` 返回内容块数组，与本次工具契约修复一致 |
| [dsh-plugin 主题页](https://github.com/topics/dsh-plugin) | 用于发现社区项目，页面本身不是插件打包规范；不能把所有带此主题的仓库视为已验证插件 |
| [dsh-desktop 插件清单](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-plugin-desktop/package.json) | `dsh-plugin-desktop` 2.0.6 使用 `type: module`、`./client` 导出、`dsh.client`、`dsh.bundle.patch` 和文件白名单；只参考共有声明，不引入其桌面构建链 |

官方发布指南中，TypeScript Git 依赖需要自行通过 `prepare` 生成运行文件，并按 pnpm 要求批准构建。retro 已提交可直接运行的 JavaScript，无需增加这一构建步骤。profile 配置按 bundle → profile → home → 命令覆盖层应用，行配置是整块替换；这与插件内部“默认值 → 行配置 → 运行时配置文件”的合并顺序是不同层次。

通过已配置的 SSH remote 成功执行 `git ls-remote origin refs/heads/main`，上传前远端基线与本地 `eaa4542c494311640e5796368052b2dbdfd659fe` 一致。匿名 GitHub 仓库 API 返回 404，因此没有据此判断仓库可见性或验证 GitHub Actions 状态。接口兼容结论限于本轮已测试的 DSH `0.1.2-rc.1`，不等同于已测试上游所有后续版本。

## 19 次提交的演进

| 日期 | 提交 | 实现阶段与保留的约束 |
| --- | --- | --- |
| 08-16 | `c928b2d` | 初始化仓库 |
| 08-16 | `d38d048` | 建立采集到发布的五层管线、命令与模型工具 |
| 08-16 | `eec6d2b` | 补全进化闭环、测试与独立 HTML 面板 |
| 08-16 | `29f9ebd` | 增加根 README，形成项目说明 |
| 08-16 | `80f10b5` | 修复标题净化、进化建议解析；保留章节解析回归 |
| 08-16 | `77e6aeb` | 已复盘会话不重复建议；保留采集器与队列双重过滤 |
| 08-16 | `ed10b94` | 草稿按日期、时间、主题命名 |
| 08-16 | `a8c28a7` | 默认落库目录归入 Index 体系 |
| 08-16 | `7fc8d4d` | 工具错误按 callId 关联工具名和错误码 |
| 08-16 | `92787e2` | 周报引入素材兜底与用户反馈 |
| 08-16 | `8822336` | 博客路径支持空格，修复旧实例存储引用问题 |
| 08-16 | `6bbede0` | 同日未处理周报去重，提供 `--force` |
| 08-17 | `9987049` | 增加 DSH 原生客户端面板与运行时 bundle |
| 08-17 | `0adfc87` | 客户端强制注入依赖改为空，保留兼容宿主加载的约束 |
| 08-17 | `6f973c9` | 从卡片提取经验字段，面板增加轮询刷新 |
| 08-17 | `9172cff` | 优先挂载原生侧边栏，保留浮动降级入口 |
| 08-17 | `d867367` | 面板支持复制命令和 Obsidian URI |
| 08-17 | `ff10957` | 清理已丢弃草稿，批量采纳前进行提案去重 |
| 08-17 | `eaa4542` | 补齐去重函数导入，添加批量采纳回归守卫 |

这段历史说明：裸包名发现、零强制客户端依赖、callId 配对、同日周报去重和批量提案去重均是已有兼容约束，本次标准化继续保留。

## 本次变更对照

| 原问题 | 当前处理 | 主要验证 |
| --- | --- | --- |
| 根目录没有 npm 包，GitHub 仓库依赖无法直接按预期安装 | 根清单指向现有源码，子目录保留私有兼容入口 | 清单一致性、实际 pack 与按包名加载 |
| 安装说明混用源码路径、手工链接和 bundle | 统一官方 `dsh plugin` 命令，补充旧 profile 迁移说明 | 在线发布指南、本地官方 CLI 源码与包导出检查 |
| 工具返回纯字符串，可空结果与 schema 不一致 | 统一内容块输出与 nullable schema | 使用官方工具定义和校验器检查输出 |
| 工具未沿用调用者取消信号 | 传递取消与超时，取消后不写素材或卡片 | 预取消、生成中取消回归 |
| 会话销毁被当成日志事件处理 | 单独监听 `session/disposed` 并去重 | 生命周期与已有卡片回归 |
| 首次配置保存后旧实例仍读取旧值 | 更新共享配置对象，按声明类型解析输入 | 同实例配置后立即读取、数组、布尔和正整数校验 |
| 空根目录、路径规范化和目录链接边界不足 | 统一校验根目录、相对路径、受保护目录与实际路径 | 临时目录中的路径与链接回归 |
| 原子写重试成功后仍抛旧异常 | 只在第二次重命名也失败时抛错 | 代码审阅与文件写入流程测试；未单独注入系统重命名失败 |
| 技能缺少官方要求的头部，采纳短片段覆盖已有规则 | 补全技能元数据，备份后追加并保留原文 | 元数据检查、已有技能内容保留 |
| 周报将标题快照转换为对象占位文本 | 读取快照的 `title` 字段 | 模拟官方返回结构的命令测试 |
| 面板取最旧五条、缺失文件路径变为字符串 null | 按最新顺序截取，缺失路径返回 null | API 回归 |
| 单引号属性、状态文本未完整转义，卸载遗留样式 | 转义动态内容，清理本次挂载资源 | 客户端与报告回归 |
| HEAD 返回正文，方法限制和缓存声明不完整 | 支持无正文 HEAD、405 Allow、no-store | 路由方法与卸载测试 |
| 报告只能通过 Windows shell 打开，异步错误未处理 | 参数数组调用平台打开器，处理异步启动失败 | 三平台启动参数和错误事件替身 |
| 文档测试数、配置优先级和博客保证失真 | 中文注释、当前架构、完整命令说明与适配限制 | 文档与当前源码逐项核对 |

## 验证记录

本地环境：Windows，Node.js `22.16.0`，npm `11.5.2`。原基线有 47 项单元测试，另有宿主和客户端两个冒烟脚本；原客户端脚本依赖工作目录，本次改为按 `import.meta.url` 定位。

| 检查 | 本地结果 |
| --- | --- |
| `npm ci --ignore-scripts`（离线缓存） | 成功，40 个包 |
| `npm run check` | 包清单、兼容入口、patch、技能元数据与 27 个脚本语法通过 |
| `npm test` | 74 项通过，0 失败、0 跳过；含两个冒烟脚本 |
| `npm run test:package` | 20 文件 tarball 的清单、完整性、宿主和客户端按包名加载、技能路径通过 |
| 官方 CLI 临时 profile 安装 | DSH `0.1.2-rc.1` 与 pnpm `10.24.0` 离线安装 tarball，自动将 `dsh-retro` 加入 Web profile 的 bundle 列表；`--dump-config` 中出现 `id: retro`、`name: dsh-retro` |
| 根目录与旧子目录冒烟 | 两种工作目录下的宿主、客户端脚本均通过 |
| 文档与 CI 配置 | 6 份当前文档、15 个本地链接及 CI YAML 矩阵检查通过 |
| `git diff --check` | 通过，未发现空白错误 |
| 原始历史回归 | 保留标题净化、工具名配对、周报防重与 `adopt all` 等检查 |

本机受限沙箱需要在运行 Node 命令时设置：

```powershell
$env:NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
```

这是本次验证环境的路径解析兼容设置，项目本身不要求使用该变量。测试入口显式收集文件，避免 shell 通配符与工作目录差异。

CLI 安装检查使用项目临时目录中的独立 `DSH_HOME`，通过 `--offline --ignore-scripts --config.auto-install-peers=false` 安装本地产物，仅验证安装、bundle 自动注册和配置合成。该检查关闭自动安装 peer 依赖，pnpm 因此提示缺少宿主依赖；宿主模块的实际加载已由使用本机官方依赖的打包测试单独验证。CLI 检查没有启动 DSH 服务或修改日常使用的 profile。

GitHub Actions 配置覆盖 Ubuntu / Windows 与 Node.js 22 / 24。工作流尚未在本轮远端运行；本地通过不能等同于四个 CI 组合已通过。真实浏览器与真实模型调用也不在本轮自动测试范围内。

## 分发与后续复核

分发包只包含运行源码、技能、patch、两份 README、LICENSE 与正式清单。测试、规划文档、个人配置、缓存、`.serena/` 和依赖目录不进入 tarball。

官方在线文档与社区发布形式已核对。仓库上传以实际 Git 提交、推送与远端提交号核验为准；GitHub 地址安装需要相应仓库访问权限。当前实现限制见[架构文档](architecture.md#当前适配限制)。

### 本轮发布记录

本地安装包已生成在 `artifacts/dsh-retro-0.3.0.tgz`，该产物目录不进入 Git 提交。

初期的网络与自动审批故障已恢复，SSH 远端读取成功。发布记录将在正常推送完成并核对远端提交后补齐。
