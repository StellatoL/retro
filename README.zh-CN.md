# dsh-retro

[English](README.md) | **简体中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的经验复盘插件。将会话中的目标、反馈和工具失败整理为复盘草稿，经人工审阅后沉淀到 Obsidian 知识库，并支持周报、规则提案和博客联动。

```text
会话事件 → 素材 / 复盘建议 → 复盘草稿 → 人工审阅 → 正式笔记 / 经验条目
                              周报 → 规则提案 → 人工采纳 → 技能 / AGENTS.md
```

## 安装

需要 Node.js 22 或更新版本、用于管理 profile 插件的 pnpm，以及已配置模型的 DSH。DSH 的安装参见[官方仓库说明](https://github.com/deepseek-ai/deepseek-harness)，Web 界面和首次配置参见[官方快速开始](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。

当前版本针对 DSH `0.1.2-rc.1` 验证了工具契约、宿主与客户端加载，以及 CLI 安装和配置合成。

安装到 Web profile：

```sh
dsh plugin --profile web add github:StellatoL/retro
dsh --profile web --dump-config
dsh web
```

`--dump-config` 只输出合成配置，可检查其中是否出现 `id: retro`、`name: dsh-retro`。若通过 npx 使用 DSH，可将命令中的 `dsh` 替换为 `npx @deepseek-ai/dsh`。GitHub 安装需要当前环境具备仓库访问权限。

本地开发时，在仓库根目录执行：

```sh
npm ci --ignore-scripts
dsh plugin --profile web add .
```

包中声明了 `dsh.bundle`，DSH CLI 会将它加入 profile 的 bundle 列表，插入 `id: retro`、`name: dsh-retro` 的插件行。仓库包含可直接运行的 JavaScript，不需要安装时执行 `prepare` 或构建脚本。安装后重启 DSH，并刷新浏览器。客户端由宿主运行时提供，无需构建 DSH 前端。分发约定参见[官方插件发布指南](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

其他使用基础服务的 profile 可替换命令中的 `web`；Web 面板需要宿主提供 `webServer` 和客户端模块服务。

### 从旧版本升级

- 仓库根目录现在是正式分发包。原先指向 `dsh-retro/` 的本地链接仍可使用；新安装统一使用仓库根目录。
- 若个人 `cordis.patch.yml` 中已有手工插入的 `retro` 行，改用 bundle 安装时移除这条重复插入；有自定义配置时先保存配置。个人路径可通过下文的 `/retro config` 恢复。
- 手工加载时，插件行的 `name` 必须是裸包名 `dsh-retro`，客户端发现依赖包元数据。
- 首次安装会复制配套 `retro-writing` 技能；升级时保留已有技能正文。旧技能如果缺少 YAML 头部，需要补充 `name: retro-writing` 和非空 `description`，以便 DSH 发现。

## 首次配置

在 DSH 会话中执行，路径包含空格时可加引号：

```text
/retro config vaultPath "D:/Notes/My Vault"
/retro config
/retro queue
```

博客功能按需配置：

```text
/retro config blogPath "D:/Projects/my-blog"
/retro config blogBaseUrl https://example.com
```

配置更新保存后立即作用于当前插件实例。不要把个人配置写入仓库的 bundle patch。

| 配置项 | 默认值 / 作用 |
| --- | --- |
| `vaultPath` | 空；Obsidian 知识库根目录 |
| `blogPath` | 空；博客 Git 仓库根目录 |
| `blogBaseUrl` | 空；用于生成文章公开链接 |
| `stagingDir` | `Index/06_Retro/_retro`；卡片暂存区 |
| `experienceRoot` | `Index/06_Retro/经验库`；永久经验与索引 |
| `proposalsDir` | `Index/06_Retro/_proposals`；规则提案 |
| `entriesDir` | `Index/06_Retro/_entries`；条目草稿 |
| `settleDirs` | `Index/03_Full_Notes/04_Retro`、`Index/04_Projects`、`Index/06_Retro/经验库` |
| `readWhitelist` | `Index`；允许读取的知识库相对目录 |
| `templates` | `experience`、`permanent`、`weekly` 三类模板路径，默认在 `Index/99_system/_templates/` 下 |
| `autoProposeOnGoalComplete` | `true`；目标完成时提出复盘建议 |
| `weeklyReminderDays` | `7`；周报提醒间隔，不是定时任务 |
| `llmProvider` / `llmModel` | `deepseek-official` / `deepseek-v4-flash`；须在 DSH 中可用 |
| `distillMaxChars` / `chunkChars` | `30000` / `12000`；长会话分段参数，必须为正整数 |
| `blogAutoPush` | `false`；只有显式开启或传入 `--push` 才推送博客仓库 |

`/retro config <key>` 查看单项，`/retro config <key> <value>` 修改单项。目录列表使用逗号分隔，布尔值使用 `true` 或 `false`；模板映射可直接编辑运行时 JSON 配置文件，重新加载插件后生效。

配置优先级为 **默认值 < Cordis 行配置 < 运行时配置文件**。环境变量 `DSH_RETRO_VAULT`、`DSH_RETRO_BLOG`、`DSH_RETRO_BLOG_URL` 只补齐合并后仍为空的对应配置，不覆盖已配置的值。

## 使用流程

1. 完成一次 DSH 会话后，用 `/retro queue` 查看素材与建议，或直接运行 `/retro draft today`。
2. 在 Obsidian 中打开卡片暂存文件，审阅正文与“待确认问题”。
3. 运行 `/retro review <id> keep` 落库，同时生成一份经验条目草稿。
4. 修改经验条目后，运行 `/retro entry keep <id>` 保存为永久笔记，更新经验库索引。
5. 用 `/weekly` 汇总最近七天的会话、素材和反馈；审阅生成的规则提案后，用 `/retro adopt <id>` 采纳。

自动采集本身不调用模型。生成草稿和周报时，材料会交给配置的 DSH 模型服务处理。目标完成只创建复盘建议；正式落库、规则采纳和博客发布由对应命令触发。

| 命令 | 作用 |
| --- | --- |
| `/retro` 或 `/retro queue` | 查看待复盘、草稿、条目、提案与发布队列 |
| `/retro draft today\|week\|all\|workspace\|session:<id>` | 按范围生成卡片；跳过已有卡片的会话 |
| `/retro review <id> keep [--dir <目录>]` | 读取审阅后的暂存文件并落库；目录必须在 `settleDirs` 中 |
| `/retro review <id> discard` | 标记丢弃，暂存文件保留至清理 |
| `/retro review <id> edit <意见>` | 记录修订意见；修改暂存文件后可再次 `keep` |
| `/retro entry keep <id>` | 经验条目落库并刷新索引 |
| `/retro adopt <id\|all>` | 将提案中的规则片段追加到技能或全局规则；已有文件备份为 `.bak` |
| `/retro cleanup` | 删除已丢弃卡片对应的暂存文件，保留状态记录 |
| `/retro report` | 生成独立 HTML 报告，尝试通过系统默认打开器打开 |
| `/weekly [--force]` | 最近七天周报；同一天已有待审周报时默认不重复生成 |
| `/blog list` | 查看博客文章 |
| `/blog draft <知识库相对路径\|卡片ID>` | 从笔记或卡片生成博客草稿 |
| `/blog publish <slug> [--push]` | 关闭草稿标记，提交该文章，可选推送 |
| `/blog capture [published\|recent\|all]` | 将文章元数据抓回为条目草稿；`recent` 当前与 `published` 相同，`all` 包含草稿 |

为限制单次模型开销，`today` 最多处理 5 个会话，`week` 与 `workspace` 最多 8 个，`all` 最多 10 个。`workspace` 按 DSH 宿主的启动目录匹配会话。批量采纳使用文本相似度去重，每组采纳一份，重复项标记为 `skipped`。

模型可调用两个工具：`retro_capture` 记录素材，`retro_draft` 生成指定会话的暂存草稿。工具不提供正式落库或发布操作。

## Web 面板与报告

Web 侧边栏底部显示“复盘”按钮；插槽不可用时显示浮动按钮。面板打开后每 30 秒刷新统计、待审卡片、待确认条目、待采纳提案、最近落库与审计记录。

点击条目复制相应命令，点击文件按钮通过 `obsidian://` 打开笔记。确认动作仍需在会话中执行。浏览器所在设备需要安装 Obsidian，并能打开同名知识库。

面板使用同源只读 `GET /retro/api`，支持 `HEAD`，拒绝其他方法且不缓存响应。独立报告保存在状态目录的 `retro-report.html`；Windows、macOS、Linux 分别使用系统文件打开器、`open`、`xdg-open`。无桌面环境时可手动打开生成的 HTML 文件。

## 博客适配范围

当前适配 `src/content/posts/*.md`，使用简单 YAML frontmatter，包含 `title`、`published`、`draft`、`description`、`tags`、`category` 等字段。它是面向这一目录与字段约定的适配器，不是通用 Astro 内容集成。

新文章带 `draft: true`。**生产构建是否排除草稿取决于站点代码**，需在站点的内容查询中实现过滤。发布命令会更新文章并运行 Git；推送后的部署行为由博客仓库的 CI 决定。Git 失败时文章可能已经更新，命令会返回实际失败情况。

## 数据位置

```text
$DSH_HOME/                              # 未设置时为 ~/.dsh
├── retro/
│   ├── config.json                    # 个人运行时配置
│   ├── store.json                     # 状态与最近 2000 条审计
│   ├── retro-report.html              # 按命令生成
│   └── apply-error.log                # 初始化失败时生成
├── skills/retro-writing/SKILL.md       # 首次安装；后续采纳追加规则
└── AGENTS.md                          # 采纳 agents 提案时写入
```

`DSH_RETRO_DIR` 可单独覆盖 `retro/` 状态目录；它不改变技能与全局规则的目标位置。状态存储适用于单个 DSH 进程；并行运行多个 profile 时应分别设置状态目录，避免覆盖同一份 JSON。

知识库默认布局：

```text
Index/
├── 03_Full_Notes/04_Retro/             # 人工确认后的复盘
└── 06_Retro/
    ├── _retro/                       # 卡片暂存
    ├── _entries/                     # 经验条目草稿
    ├── _proposals/                   # 技能与规则提案
    └── 经验库/00_索引.md
```

卡片、常规条目和提案采用“日期-时间-主题”文件名，重名追加序号；博客抓取条目使用内部 ID。文件操作校验配置根目录、相对路径、只读白名单和现有目录链接，拒绝越界与 `.git`、`.obsidian`、`.trash` 等受保护目录。知识库自身不要求是 Git 仓库；备份由使用者选择的方案负责。

## 开发

在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

静态检查验证包清单、导出、技能元数据和源码语法；测试包含官方 DSH 工具契约、文件边界、流程与客户端冒烟；打包检查会实际生成并解包 tarball，验证按包名加载。测试使用临时状态、知识库和博客目录，替换模型、Git 和浏览器启动。

- [当前架构](docs/architecture.md)
- [变更记录](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)

## 许可

[MIT](LICENSE)
