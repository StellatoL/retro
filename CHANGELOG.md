# 变更记录

## 未发布（0.7.0 开发中）

- P2 资源视图：快照支持 `resource=materials|weekly|blog|entries` 列表（素材可按 `kind`/`session` 过滤），新增 `GET /retro/detail?type=blog` 返回 frontmatter、正文与发布前预检（draft 标记、缺失本地图片）。
- 客户端新增素材 / 周报 / 博客 / 经验库四个视图；博客详情展示预检结果并可复制发布命令。
- 博客未配置时统一返回 `RETRO_BLOG_UNAVAILABLE`，而不是抛出未分类异常。
- 新增 5 项 P2 后端单测与客户端视图入口断言。
- P1 提案审阅：`GET /retro/detail?type=proposal` 返回将追加的行、目标文件末尾上下文、目标是否存在与相似提案提示（bigram Jaccard）。
- P1 批量采纳：`POST /retro/action` 新增 `proposal.adopt`（支持 `ids` 数组或 `all`，`all` 仍按相似度去重并标记 skipped）。
- P1 内联编辑：新增 `card.patch` 动作与 `actions.patchCard`，按二级标题局部写回暂存文件并更新 `contentHash`，同样受乐观锁保护。
- 客户端：提案视图展示追加 Diff 与重复警告、勾选批量采纳；卡片详情支持行动项/关键经验内联编辑并保存到暂存区；列表支持 j/k/方向键与 Enter/Esc 键盘操作。
- 新增 5 项 P1 后端单测与 1 项客户端冒烟（提案 Diff + 批量采纳）。

## 0.6.0 — 2026-11-05

- P0 基础层：新增 `lib/guard.js`（跨进程 `store.lock`、内容哈希、写前 `.bak` 备份、笔记读取作用域）。
- store 升级为 v2：`meta.schemaVersion` 与单调递增 `meta.rev`；旧文件首次加载自动备份 `store.v1.bak.json` 再原地升级，旧字段全部保留。
- 配置支持分组点号键（`security.enableWriteApi` 等），写接口与全库笔记预览默认关闭。
- `util.js` 新增 `patchMarkdownSections`：按二级标题局部替换卡片正文，保留用户手写章节。
- 新增动作服务层 `lib/actions.js`，`/retro` 三组写入命令改为薄适配器，行为与审计完全一致。
- 新增只读查询层 `lib/query.js` 与 `GET /retro/detail`：快照支持 `sinceRev` 轻量响应、状态过滤、关键字搜索与游标分页；详情返回卡片/提案/条目/白名单笔记。
- 新增受控写接口 `POST /retro/action`：默认关闭（403 `RETRO_WRITE_DISABLED`），开启后仅放行 `card.review`，与命令共用动作服务层，支持 `expectedHash` 乐观锁（409）。
- 新增 `GET /retro/events` 事件流：显式 `Content-Encoding: identity` 防压缩缓冲，首帧立即下发 `rev`，25 秒心跳；客户端 15 秒无字节自动降级轮询。
- 客户端重构为零 HTML 注入：Markdown 解析为 React 节点，新增卡片/提案视图、状态筛选、关键字搜索、详情面板、自绘侧边栏角标；浮动入口改为调用 `ctx.layout.selectPanel`，不再自建 DOM 面板。
- 新增 32 项单测（store v2 迁移、并发锁、笔记作用域、Markdown 合并、分组配置、动作服务、读取端点、写接口与事件流），客户端冒烟改为节点级断言（含 XSS 载荷与卸载清理）。

## 0.5.0 — 2026-11-05

- 新增左侧栏入口：按 DSH 0.2 的插槽契约注册 `main` 面板与 `sidebar.panellist` 图标行，点击侧边栏“复盘”行即在主区域打开面板。
- 主区域面板复用同一份数据渲染与 30 秒轮询，点击条目复制命令、文件按钮打开 Obsidian 的行为保持一致。
- 侧边栏座位缺失或注册失败时保留浮动入口兜底，入口就绪后自动撤下浮动按钮。
- 同步中英文 README、架构文档与客户端冒烟测试（覆盖左侧栏入口、主区域渲染与延迟兜底）。

## 0.4.0 — 2026-11-05

- 清单新增 `engines.dsh`（`^0.2.2-rc.1`），peer 与开发依赖对齐 DSH `0.2.2-rc.1`、Cordis `4.1.0`，由宿主在激活前校验兼容性。
- 修复 Web 面板在 DSH 0.2 下不可达：`slots.inject` 对未声明的座位会静默等待，改为以注册回调是否真正执行判断挂载，缺失座位时由浮动入口兜底，座位稍后出现再自动撤下浮动入口。
- 修复 Windows 目录联接导致文件边界测试在清理阶段报 `ENOTEMPTY`。
- 校验脚本新增 `engines.dsh` 存在性与 peer 依赖范围一致性检查。
- README 提供英文与简体中文两版，增加语言切换入口。
- 历史规划与执行记录改为仅本地保留，公开文档集中于安装、使用、架构与协作。

## 0.3.0 — 2026-09-09

- 新增仓库根 npm 分发入口、锁文件、包元数据、MIT 随包检查与正式安装说明，保留旧子目录的本地兼容入口。
- 对齐 DSH `0.1.2-rc.1` 工具输出、取消信号、会话销毁事件、标题快照与技能元数据契约。
- 修复运行时配置不立即生效、配置类型解析、空根路径、目录链接与读取白名单边界。
- 规则提案采纳改为备份后追加，保留已有技能正文与 frontmatter。
- 修复面板最近落库顺序、空文件路径、HTML 转义和卸载清理；补全 GET/HEAD 与缓存语义。
- 支持 Windows、macOS、Linux 的报告打开器，并处理异步启动失败。
- 统一中文源码注释，新增当前架构、标准化记录、贡献指南和跨平台 CI。
- 测试入口统一到仓库根目录，加入实际 tarball 加载验证。

## 既有实现 — 2026-08-16 至 2026-08-17

形成采集、提炼、沉淀、进化、发布管线；新增周报、独立报告和原生 Web 面板，逐步补全去重、经验字段提取、文件命名和用户交互。

完整演进见 [Git 提交历史](https://github.com/StellatoL/retro/commits/main/)。
