# dsh-retro

**DSH 经验复盘管线**——把「对话/工程结束 → 自动沉淀经验 → 你在 Obsidian 中深度审阅与进化 → 双向联动 Blog」构建成一条 CI/CD 式自动化流水线，以标准 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 插件形态交付。

```
采集 Collect → 提炼 Distill → 沉淀 Settle → 进化 Evolve → 发布 Publish
```

## 特性

- **采集**：订阅会话事件流，采样 goal 完成 / 用户反馈 / 复盘意向 / 工具失败等素材
- **提炼**：LLM 按你的 Obsidian 模板生成复盘卡片初稿 +「待确认问题」清单；长会话自动分段 map-reduce
- **沉淀（人机协作核心）**：AI 只写暂存区白名单；你在 Obsidian 中审阅/修改后 `/retro review <id> keep` 才落库；支持 keep / discard / edit 打回
- **进化闭环**：`/weekly` 自动提炼「进化提案」（skill / AGENTS.md 两类）→ `/retro adopt` 确认后写入 `~/.dsh/skills` 或 `~/.dsh/AGENTS.md`（自动 .bak），下次对话模型即遵循新规则；经验库 MOC 索引自动维护
- **发布**：Obsidian ⇄ Astro Blog 双向（`draft: true` 草稿在生产构建绝不发布；git 提交/推送；文章抓回为经验条目草稿）
- **复盘面板**：`/retro report` 生成自包含 HTML 仪表盘并自动打开
- **隐私中性**：代码不硬编码个人路径，全部走运行时配置或环境变量；所有写入留审计日志，vault 与 blog 均为 git 仓库可回滚

## 目录结构

```
├── dsh-retro/                # 插件主包（ESM，{ name, inject, apply }）
│   ├── lib/
│   │   ├── index.js          # 插件入口（装载采集/命令/工具）
│   │   ├── collectors.js     # 事件采集
│   │   ├── distiller.js      # LLM 提炼（复盘卡片 / 周报 / 进化提案）
│   │   ├── settler.js        # 暂存白名单 / 模板渲染 / 确认落库
│   │   ├── evolvor.js        # 经验库 / MOC 索引 / 提案与采纳
│   │   ├── publisher.js      # Blog 双向
│   │   ├── report.js         # HTML 复盘面板
│   │   ├── commands.js       # /retro /weekly /blog 命令面
│   │   ├── tools.js          # 模型工具 retro_capture / retro_draft
│   │   ├── store.js          # 持久化（素材/卡片/条目/发布/审计）
│   │   ├── config.js         # 配置（默认值 < 行配置 < 运行时文件 < 环境变量）
│   │   └── util.js           # 原子写 / 白名单 / 模板工具
│   ├── skills/retro-writing/ # 复盘写作规范技能
│   └── test/                 # 单元与集成测试（34 项）
├── PLAN.md                   # 完整设计与规划（v2，含风险登记册）
└── LICENSE
```

## 快速开始

详见 [`dsh-retro/README.md`](dsh-retro/README.md)（安装、命令表、进化闭环说明）。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml — 本地插件按官方文档模式注册
- insert:
    - id: retro
      name: './node_modules/dsh-retro/lib/index.js'
      config: {}
```

```powershell
# 把包放进 profile 的 node_modules（junction 指向本仓库，改代码即时生效）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-retro" -Target "<本仓库绝对路径>" -Force
# 重启 dsh web 后生效
```

**配置**（`/retro config` 读写 `~/.dsh/retro/config.json`，或环境变量）：

| 配置 | 环境变量 | 说明 |
|---|---|---|
| `vaultPath` | `DSH_RETRO_VAULT` | Obsidian 库路径 |
| `blogPath` | `DSH_RETRO_BLOG` | Astro Blog 仓库路径 |
| `blogBaseUrl` | `DSH_RETRO_BLOG_URL` | 站点公开 URL |

## 常用命令速查

| 命令 | 作用 |
|---|---|
| `/retro queue` | 队列总览（待复盘/草稿/条目/提案/发布） |
| `/retro draft today\|week\|all\|workspace\|session:<id>` | 生成复盘草稿到暂存区 |
| `/retro review <id> keep [--dir ...] \| discard \| edit <意见>` | 确认落库 / 丢弃 / 打回 |
| `/retro entry keep <id>` | 经验条目沉淀为永久笔记（自动刷新 MOC 索引） |
| `/retro adopt <id\|all>` | 采纳进化提案（.bak 备份） |
| `/retro report` | 生成 HTML 复盘面板并打开 |
| `/weekly [--force]` | 本周复盘汇总（自动提炼进化提案） |
| `/blog draft\|publish\|capture\|list` | Obsidian ⇄ Blog 双向 |

## 开发与测试

```bash
cd dsh-retro
node test/smoke.test.js      # 基础单元测试（17）
node test/publisher.test.js  # Blog 发布管线（6，git 注入，不真跑 git）
node test/pipeline.test.js   # 采集/提炼/进化/命令（9）
node test/report.test.js     # HTML 面板（2）
node test/ctx-smoke.mjs      # 插件装载集成冒烟
```

## 隐私与安全

- 仓库内**无任何个人路径与凭据**；个人配置在 `~/.dsh/retro/config.json`（已 gitignore）
- 自动写入仅限暂存区白名单（`Index/06_Retro/_retro` 等），正式落库/发布只发生在人工命令路径
- `vaultPath` 未配置时写入直接报错，绝不回退到相对路径
- 所有写入留审计日志（`~/.dsh/retro/store.json`），vault 与 blog 均为 git 仓库可回滚

## License

MIT
