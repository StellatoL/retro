# DSH 经验复盘管线（dsh-retro）— 历史设计 v2

> 历史归档：本文记录 2026-08-16 基于 DSH 0.1.0-rc.6 的设计过程，保留当时的结论和计划。文中的接口、安装方式、测试数量及博客构建假设可能已经变化。当前行为请阅读 [README](README.md)、[当前架构](docs/architecture.md) 与 [标准化记录](docs/standardization.md)。

> 目标：把"对话/工程结束后自动沉淀经验 → 用户在 Obsidian 中深度审阅与进化 → 双向联动 Astro Blog"构建成一条 CI/CD 式自动化流水线，以**标准 DSH 插件**形态交付。
>
> 流水线：**采集 Collect → 提炼 Distill → 沉淀 Settle → 进化 Evolve → 发布 Publish**，人机共同参与，AI 只写暂存区，用户掌握最终落库权。
>
> v2 变更：本节以下所有"已验证"结论均对照本机 DSH 包源码（0.1.0-rc.6）与你的 vault/blog 实际文件逐一核实，不再有"实现时再验证"的设计级假设。

---

## 0. 已核验事实清单（设计依据）

| # | 事实 | 核验来源 | 对设计的影响 |
|---|---|---|---|
| F1 | 插件 = ESM npm 包导出 `{name, inject, apply}`；bundle manifest = `package.json` 内 `dsh.bundle.patch: "./cordis.patch.yml"`（dsh-base 同款） | `dsh-base/package.json`、`dsh-command-goal/lib/index.js` | 插件包自带行插入，profile 只需在 `dsh.profile.bundles` 加一行 |
| F2 | `ctx.commands.register({name, description, input:{hint}, handler})` 注册 `/命令` | `dsh-commands/lib/index.js` | 全部用户操作面走命令 |
| F3 | 会话事件火线：`session/event` 随每个追加事件发出（含 `turn/start|end`、`user/message`、`assistant/message`、`tool/call|result`、`todo/write`、`feedback/record`、`goal/change`…）；另有 `session/created`、`session/disposed` | `dsh-session/lib/index.js`（firehose、invokeContainedSessionObservers） | 采集器 = `ctx.on("session/event", ...)` 订阅，可行 |
| F4 | `turn/end` 每个助手回合都触发；`session/disposed` 仅在会话销毁时触发（web 中会话常驻侧栏，非"对话结束"信号）；`goal/change` 带 `phase: complete` 是可靠的"工程结束"信号 | `dsh-agent-loop/lib/index.js`、`dsh-goal/lib/index.js` | **触发架构重设计**（见 §2） |
| F5 | `dsh-schedule` **未挂载**于 web profile（base/web-app patch 中无该行），且其机制是"会话唤醒时派发提醒"（非守护进程） | `dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`、`dsh-schedule/lib/index.js` | **周汇总不能依赖 ctx.schedule**，改用启动扫描 + 手动（见 §2） |
| F6 | `ctx.fs` 的写入被 `dsh-fs-sandbox` 按"每次调用的沙箱策略"围栏（workspace-write 拒绝工作区外写入，含 vault） | `dsh-fs-sandbox/lib/index.js`（checkedTarget） | **写入路径重设计**（见 §3）：宿主代码 node:fs + 路径白名单 |
| F7 | `ctx.sessionQuery` 公开 API：`listSessions/readSession/filterSessions/readTitle/listEvents/filterEvents` + sqlite 后端全文检索（web profile 已挂载 `session-query-sqlite`） | `dsh-session-query/lib/index.js`、profile patch | 原料读取与查重可行 |
| F8 | web profile 已挂载：`storage`+`storage-json`+`storage-domain`、`agent-instructions`、`skill`+`skill-filesystem`+`tool-skill`、`commands`、`user-questions`、`goal`、`message-feedback`、`jobs`、`subagent`、`workflow` | profile 组合 = dsh-base + dsh-web-app 两个 patch | RetroStore 可用 `ctx.storage.domain`；进化通道（skill/AGENTS.md）现成 |
| F9 | `dsh-agent-instructions` 读 workspace 的 `AGENTS.md`/`CLAUDE.md`（+`.local` 覆盖）与 **`~/.dsh/AGENTS.md`（全局用户文件）** | `dsh-agent-instructions/lib/index.js` | 进化输出目标明确：全局 `~/.dsh/AGENTS.md` + 工程级 `AGENTS.md` |
| F10 | `ctx.userQuestions.ask()` 提供程序化提问；**仅 root agent 可答**（子代理无 answerer） | `dsh-user-questions/lib/index.js` | 复盘提问仅主会话可用，子代理场景降级为写入提问清单 |
| F11 | 工具注册：`ctx.tools.register(defineTool({name, description, parameters:{schema(schemastery)}, presentCall, ...}))` | `dsh-tool-todo/lib/index.js` | 模型工具面可行 |
| F12 | Blog：`src/content/config.ts` 定义 posts schema（`title`/`published` 必填，`draft` 可选默认 false）；**`src/content/utils/content-utils.ts` 在 PROD 过滤 `draft !== true`** | `C:\Blog` 源码 | `draft: true` 草稿在生产构建中**绝不发布**，发布管线安全 |
| F13 | Blog 部署：repo 含 `.github/`（Actions）与 `vercel.json`；git 在 PATH | `C:\Blog` 目录 | 插件只负责内容 + git 提交，部署由现有 CI 完成 |
| F14 | vault 模板（`Index/99_system/_templates/experience.md` 等）含 **Templater 语法**（`<% tp.file.creation_date(...) %>`） | vault 文件 | 插件写入时必须渲染为具体值，绝不落盘未渲染的模板代码 |
| F15 | vault 为 git 仓库（obsidian-git 自动提交）；工具链：pnpm 全局已装 ✓，`dsh` CLI 不在全局 PATH（经 npx 缓存运行） | 环境勘察 | 安装走 profile 目录 pnpm；git 兜底成立 |
| F16 | skill 发现根：workspace `.dsh/skills/`、`~/.dsh/skills/`；frontmatter `{name, description, whenToUse?}` | `dsh-skill-filesystem/README` | 全局复盘规范技能放 `~/.dsh/skills/retro-writing/` |

---

## 1. 总体架构（不变）

```
┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐
│ 采集    │ → │ 提炼    │ → │ 沉淀    │ → │ 进化    │ → │ 发布    │
│Collect │   │Distill │   │Settle  │   │Evolve  │   │Publish │
└────────┘   └────────┘   └────────┘   └────────┘   └────────┘
 session/event  LLM 结构化   暂存+确认    经验库/技能    Obsidian⇄Blog
 订阅采样       复盘卡片      落库/归档    去重/提升      草稿/发布/抓回
```

---

## 2. 触发架构（v2 重设计，依据 F4/F5）

没有一等公民的"对话结束"事件（web 中会话常驻），因此采用**四级触发**：

| 级 | 触发 | 机制 | 角色 |
|---|---|---|---|
| T1 | **目标完成** | 监听 `session/event` 中 `goal/change` 且 `phase === "complete"` → 自动提议复盘（按 session 去重，一次） | "工程结束"的可靠自动信号（对应你选的"工程结束自动提示"） |
| T2 | **手动命令** | `/retro [today\|session\|week\|all\|workspace]` | 核心交互，任意时刻、任意范围 |
| T3 | **会话销毁** | `session/disposed` → 持久化"待复盘"标记（下次启动提醒）；不依赖它作主触发 | 尽力而为的兜底 |
| T4 | **周汇总兜底** | 插件启动扫描：距上次 `/weekly` > 7 天 → 会话开头温柔提醒（一条 notice + `/weekly` 一键生成） | 每周仪式的可靠实现（不依赖未挂载的 dsh-schedule） |
| T5 | （可选）会话内定时 | bundle patch 顺带插入 `dsh-schedule` 行（peerDep），注册"周五复盘提醒" | 增强项，非必需 |

要点：`turn/end` 每回合触发，**不**用于自动复盘（噪声太大）；自动触发一律只"提议"，生成动作必须经过你（`/retro` 或提醒里的确认）。

---

## 3. 写入路径与权限（v2 重设计，依据 F6）

**原则：模型永远不能直接触碰 vault 正式区；宿主服务是唯一的写手；暂存区是唯一自动写入目标。**

```
模型工具 retro_capture ──→ RetroStore（~/.dsh，域存储，只写自己的数据）
模型工具 retro_draft   ──→ 插件服务 renderDraft() ──→ vault 暂存区（stagingDir，白名单硬校验）
                                                          ↓ 你在 Obsidian 审阅/修改
人工命令 /retro review keep ──→ 插件服务 settle() ──→ 正式目录（04_Projects / 03_Full_Notes…）
人工命令 /blog draft|publish ─→ 插件服务 ────────────→ C:\Blog\src\content\posts（draft:true → 确认后 false+push）
```

- **沙箱事实**（F6）：`ctx.fs` 写入按每次调用的沙箱策略围栏，workspace-write 会话内模型工具写不到 vault——这正好**强制**了上面的分层。插件宿主代码（受信任 Node 代码）用 `node:fs` 执行 vault/blog 写入，不受模型沙箱围栏影响，但必须过**插件自建路径白名单**：
  - 唯一允许的自动写入目录：`stagingDir = <vault>/Index/06_Retro/_retro`（配置项）；其余 vault 路径、`.obsidian/`、`.git/` 一律拒绝并记审计日志。
  - 正式落库/blog 写入**只**发生在人工命令处理路径（命令是用户直接发起的，不经模型）。
- **审计与回滚**：每次写入记录（时间、来源命令、目标路径）到 RetroStore；vault 与 blog 均为 git 仓库（F15），obsidian-git 自动提交 + blog 手动提交 → 每笔写入可 diff、可回滚。
- **隐私边界**：只读白名单目录（默认 `00_Inbox/03_Full_Notes/04_Projects/05_Weekly_review/06_Retro`），绝不扫描 `01_Personal` 等；素材只存提炼结果，不复制原始会话。

---

## 4. 插件族拆解（不变，微调）

```
DSH/                                  # 开发仓库（即当前工作区）
├── PLAN.md
├── dsh-retro/                        # 主插件包（bundle 形态）
│   ├── package.json                  # dsh.bundle.patch + peerDeps（@deepseek-ai/dsh-*）
│   ├── cordis.patch.yml              # 插入行：retro / retro-store / retro-commands
│   │                                 #  （可选再插 dsh-schedule 行，见 T5）
│   ├── src/
│   │   ├── index.ts                  # { name, inject, apply }
│   │   ├── store.ts                  # RetroStore：dsh-storage-domain（F8）或 ~/.dsh/retro/*.json 回退
│   │   ├── collectors.ts             # session/event 订阅采样（F3）
│   │   ├── distiller.ts              # LLM 提炼（ctx.llm，分段 map-reduce 控成本）
│   │   ├── settler.ts                # 暂存/确认/落库 + 路径白名单 + 模板渲染（F14）
│   │   ├── evolvor.ts                # 经验库、去重、SKILL.md/AGENTS.md 建议（F9/F16）
│   │   ├── publisher.ts              # blog 双向（schema 渲染 F12、git 提交 F13）
│   │   ├── tools.ts                  # retro_capture / retro_draft / retro_ask（F11）
│   │   └── commands.ts               # /retro、/weekly、/blog（F2）
│   └── skills/retro-writing/SKILL.md # 随包附带技能（可复制/引用到 ~/.dsh/skills）
└── dsh-retro-client/                 # 已降级：见 §6 M5
```

### 4.1 命令面

| 命令 | 作用 | 写权限 |
|---|---|---|
| `/retro [today\|session\|week\|all\|workspace]` | 生成复盘草稿到暂存区 | 只写 stagingDir |
| `/retro review <id> [keep\|merge\|discard\|<修改意见>]` | 确认/合并/丢弃/打回 | keep 时写正式目录 |
| `/retro queue` | 查看待审卡片 | 只读 |
| `/weekly` | 本周汇总卡片 + 进化报告 | 只写 stagingDir（周报也走确认） |
| `/blog draft <note>` | 经验 → blog 草稿（draft:true，F12 安全） | 只写 blog posts 目录 |
| `/blog publish <slug>` | 草稿 → 正式（draft:false + git commit/push） | blog + git |
| `/blog capture [recent\|all]` | blog 文章 → vault 永久笔记（草稿→暂存区） | 只写 stagingDir |
| `/retro config` | 查看/修改配置 | ~/.dsh 配置 |

### 4.2 模型工具面

| 工具 | 作用 | 写入 |
|---|---|---|
| `retro_capture` | 会话中标记值得沉淀的素材 | RetroStore |
| `retro_draft` | 生成复盘卡片初稿 | 经服务写 stagingDir（白名单唯一路径） |
| `retro_ask` | 向用户提问（F10：仅主会话） | 无 |

### 4.3 配置项

```yaml
vaultPath: "<vaultPath>"                   # 运行时配置 ~/.dsh/retro/config.json 或 DSH_RETRO_VAULT
blogPath: "<blogPath>"                     # 同上，DSH_RETRO_BLOG
blogBaseUrl: "<blogUrl>"                   # 站点公开 URL，DSH_RETRO_BLOG_URL
stagingDir: "Index/06_Retro/_retro"        # 复盘卡片暂存区（唯一自动写入目录，白名单）
experienceRoot: "Index/06_Retro/经验库"    # 永久经验库
proposalsDir: "Index/06_Retro/_proposals"  # 进化提案
entriesDir: "Index/06_Retro/_entries"      # 经验条目草稿
readWhitelist: ["00_Inbox","03_Full_Notes","04_Projects","05_Weekly_review","06_Retro"]
templates: { experience: "Index/99_system/_templates/experience.md", ... }
autoProposeOnGoalComplete: true            # T1
weeklyReminderDays: 7                      # T4
blogAutoPush: false                        # 默认手动确认
```

---

## 5. 数据模型（不变）

```
SessionMaterial { sessionId, workspace, ts, kind, summary, importance 0-3, links[] }
RetroCard       { id, sessionIds[], workspace, title, status(suggested|drafted|reviewing|approved|published|archived),
                  fields{goal, env, process, pitfalls[], takeaways[], actions[], resources[]}, questions[], vaultNote?, blogSlug? }
ExperienceEntry { id, title, use, model, example, pitfalls[], links[], tags[], source, createdAt, updatedAt }
PublishItem     { slug, title, status(drafted|reviewed|published), publishedAt, blogUrl, sourceNote }
AuditLog        { ts, actor(command|tool|sweep), action, target, ok }
```

存储：`ctx.storage.domain("retro")`（web profile 已挂载 storage-domain，F8）；headless/其他 profile 无该服务时回退 `~/.dsh/retro/*.json`（node:fs）。vault/blog 内产物永远是 Markdown。

---

## 6. 分阶段路线图（修订）

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| M0 脚手架 | 仓库、包结构、bundle 挂载进 web profile（F1/F15：profile 目录 pnpm 安装 + bundles 一行）、`session/event` 订阅与 `/retro` 空命令跑通 | 可加载插件 + 命令可交互 | 0.5 天 |
| M1 采集+手动复盘 | collectors（F3）、RetroStore（F8）、`/retro` → 暂存草稿（白名单+模板渲染 F14）、`/retro review` 确认落库 | "对话→草稿→确认→落库"端到端 | 1–2 天 |
| M2 触发完善 | T1 goal-complete 自动提议、T3 销毁标记、T4 启动周检 + `/weekly` 汇总 | 无人值守提醒 + 周会仪式 | 1 天 |
| M3 Blog 双向 | `/blog draft|publish|capture`（F12 schema、F13 git） | Obsidian ⇄ Blog 闭环 | 1–2 天 |
| M4 进化机制 | 经验库 MOC、查重/链接建议（F7）、SKILL.md 建议（F16）、`~/.dsh/AGENTS.md` + workspace `AGENTS.md` 偏好注入（F9）、周进化报告 | "自我进化"闭环 | 1–2 天 |
| M5 复盘面板（修订） | **HTML 静态报告**（插件生成 report.html + 默认浏览器打开，零前端构建） | 可视化复盘面板 | 1 天 |
| M6（远期可选） | 真·Web 面板 = dsh-retro-client 客户端插件 | GUI 集成 | 需 DSH 仓库完整 checkout + web 构建工具链（npx 缓存无源码），3 天+ |

---

## 7. 风险登记册（全部已核验/已给对策）

| # | 风险 | 状态 | 对策 |
|---|---|---|---|
| R1 | 官方文档站沙箱不可达 | 已闭环 | 已用本地包源码核验全部接口（F1–F16）；实现期对照文档复核 |
| R2 | `dsh-schedule` 不可靠/未挂载 | **已核验并重设计** | 不依赖它：T4 启动扫描是周汇总主机制；T5 挂载仅作增强（F5） |
| R3 | `session/disposed` 不是"对话结束"信号 | **已核验并重设计** | 主触发改为 T1 goal-complete + T2 手动 + T4 周检（F4） |
| R4 | 模型工具经 ctx.fs 写不到 vault（沙箱围栏） | **已核验并重设计** | 分层写路径：模型→服务→白名单暂存区；宿主 node:fs + 人工命令才写正式区（F6，§3） |
| R5 | 会话查询全文搜索方法名待实现期确认 | 已给 fallback | 主索引在 RetroStore；`sessionQuery` 用 `readSession/filterEvents` 读原料（F7），搜索细节 M4 核对 |
| R6 | vault 模板随用户编辑漂移 | 新增对策 | 插件**读模板文件渲染**而非硬编码字段；模板缺失时内置回退模板并警告 |
| R7 | 多 DSH 实例并发写 | 新增对策 | 文件命名带时间戳+短 id；写入前存在性检查；个人单机场景低风险 |
| R8 | 写入误伤 `.obsidian/`、`.git/` | 新增对策 | 路径白名单 + 明确拒绝列表 + 审计日志（§3） |
| R9 | 模板 Templater 语法未渲染落盘 | 已核验 | 插件渲染具体日期/标题后才写入（F14） |
| R10 | `retro_ask` 在子代理中无 answerer | 已核验 | 主会话用 ask；子代理降级为写"提问清单"到草稿（F10） |
| R11 | 蒸馏 LLM 成本/上下文 | 新增对策 | 分段 summarize-map-reduce；周汇总 N+1 次调用；模型用会话默认配置 |
| R12 | `~/.dsh/AGENTS.md` 不在 git 中，进化更新不可回滚 | 新增对策 | 插件每次修改前备份 `.bak`；更新记录进 RetroStore |
| R13 | headless profile 可能未挂载 storage-domain | 新增对策 | 存储双后端：domain 可用则用，否则文件回退（§5） |
| R14 | 幻觉工具参数触发宿主写入 | 新增对策 | 工具→服务间只允许 stagingDir 一个写目标；写入全量审计；正式区只能人工命令（§3） |
| R15 | blog 发布误发 | **已核验安全** | `draft:true` 在 PROD 构建被过滤（F12）；发布需人工命令 + `blogAutoPush:false` 默认 |
| R16 | DSH 版本升级导致 peerDep/事件漂移 | 已评估 | 插件锁定 peerDep 版本范围；事件只依赖 F3 已稳定的词汇表；升级时跑 M0 冒烟 |

---

## 8. 结论

设计经过第二轮逐项核验后，**所有"实现时再验证"的假设都已消除**，关键修正：

1. **触发**：以 goal-complete（可靠自动信号）+ 手动命令 + 启动周检为主，不依赖 session/disposed 与未挂载的 schedule（F4/F5）。
2. **写入**：模型 → 插件服务 → 暂存区白名单的三层写路径，正式落库与发布只走人工命令；沙箱围栏恰好天然强制了这条纪律（F6）。
3. **发布**：draft 机制在生产构建绝对安全（F12），部署沿用你现有 CI（F13）。
4. **进化**：输出目标精确到 `~/.dsh/AGENTS.md`（全局）+ workspace `AGENTS.md`（工程级）+ `~/.dsh/skills/retro-writing/`（技能），每层"AI 起草、你确认"（F9/F16）。
5. **M5 修订**：以零前端构建的 HTML 报告替代客户端插件方案，Web 面板降为远期可选。

下一步：确认后从 **M0 脚手架** 开始实施。
