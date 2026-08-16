# dsh-retro

DSH 经验复盘管线：**采集 → 提炼 → 沉淀 → 进化 → 发布**。

- 会话/工程结束（goal 完成、会话销毁）自动提议复盘；
- LLM 按你的 Obsidian 模板生成复盘卡片**初稿**，只写入暂存区（`Index/06_Retro/_retro`）；
- 你在 Obsidian 中审阅/修改后，`/retro review <id> keep` 确认落库；
- 经验可沉淀为永久笔记（`Index/06_Retro/经验库`），并双向联动 Astro Blog。

## 配置（隐私说明）

代码中**不硬编码任何个人路径**。运行时配置在 `~/.dsh/retro/config.json`（`/retro config` 读写），或环境变量：

| 配置 | 环境变量 | 说明 |
|---|---|---|
| `vaultPath` | `DSH_RETRO_VAULT` | Obsidian 库路径 |
| `blogPath` | `DSH_RETRO_BLOG` | Astro Blog 仓库路径 |
| `blogBaseUrl` | `DSH_RETRO_BLOG_URL` | 站点公开 URL（发布链接用） |

未配置时相关命令会给出明确报错，不会回退到相对路径写入。

## 安装

按官方文档（develop/basic「第一个插件」）的模式：本地插件在 profile 的 `cordis.patch.yml` 中以**相对 profile 目录的路径**注册（patch 文件只贡献配置，不改变 loader 的模块解析根）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: retro
      name: './node_modules/dsh-retro/lib/index.js'
      config: {}
```

```powershell
# 1. 把包放进 profile 的 node_modules（junction 指向本仓库，改代码即时生效）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-retro" -Target "<本仓库绝对路径>" -Force

# 2. 重启 dsh web（或由 cordis HMR 热加载 patch 变更后直接生效）
```

> Windows 注意：官方文档示例用绝对路径 `name: '/abs/path/plugin.ts'`，但 Windows 上绝对路径会触发 internal loader 的 `file://` 怪癖（`protocol 'c:'`）；相对路径（相对 profile 目录）在 Windows 上可靠。
>
> 若将来发布到 npm，可把包安装进 dsh 安装目录后改用裸包名 `name: dsh-retro`（包内 `cordis.patch.yml` 已带包名行，作为 bundle 使用）。

## 命令

> **命名约定**：所有生成的草稿/落库/条目/提案文件统一命名为 `日期-时间-简要主题.md`（如 `2026-08-16-2215-dsh-插件复盘.md`），同名冲突自动追加 `-2`、`-3`。

| 命令 | 作用 |
|---|---|
| `/retro queue` | 队列总览（待复盘/草稿/条目/提案/发布） |
| `/retro draft today\|week\|all\|workspace\|session:<id>` | 生成复盘草稿到暂存区 |
| `/retro review <id> keep [--dir 03_Full_Notes]` | 确认落库（默认 03_Full_Notes） |
| `/retro review <id> discard` | 丢弃 |
| `/retro review <id> edit <意见>` | 打回修订 |
| `/retro entry keep <id>` | 经验条目沉淀为永久笔记 |
| `/retro config [k v]` | 查看/修改配置（`~/.dsh/retro/config.json`） |
| `/retro adopt <id\|all>` | 采纳进化提案（skill/AGENTS.md，自动 .bak） |
| `/retro report` | 生成 HTML 复盘面板（自包含，自动用浏览器打开） |
| `/weekly [--force]` | 本周复盘汇总（自动提炼进化提案 + 刷新经验库索引） |
| `/blog list` | 文章列表 |
| `/blog draft <notePath\|cardId> [--tags a,b]` | 生成 blog 草稿（draft:true，生产不发布） |
| `/blog publish <slug> [--push]` | 发布（git 提交，可选推送） |
| `/blog capture [recent\|all]` | 文章抓回为经验条目草稿 |

## 模型工具

- `retro_capture`：会话中标记值得沉淀的素材
- `retro_draft`：为指定会话生成复盘草稿（写入暂存区）

## 进化闭环

1. `/weekly` 生成周报后，自动把"进化建议"提炼为**结构化提案**（skill/AGENTS.md 两类）；
2. `/retro queue` 可见待采纳提案；`/retro adopt <id>` 确认后写入 `~/.dsh/skills/retro-writing/SKILL.md` 或 `~/.dsh/AGENTS.md`（原文件自动备份 `.bak`）——下次对话模型即遵循新规则；
3. 经验条目沉淀（`/retro entry keep`）后自动刷新经验库 MOC 索引（`Index/06_Retro/经验库/00_索引.md`）。

## 数据与安全

- 状态与审计：`~/.dsh/retro/store.json`（所有写入留痕）
- 自动写入仅限暂存区白名单；正式落库/发布只发生在人工命令路径
- vault 与 blog 均为 git 仓库，可随时回滚
- 只读白名单默认：`00_Inbox / 03_Full_Notes / 04_Projects / 05_Weekly_review / 06_Retro`
