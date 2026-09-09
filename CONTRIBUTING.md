# 贡献指南

在仓库根目录开发。需要 Node.js 22 或更新版本，以及 npm；不需要构建前端或在个人知识库中运行测试。

## 本地验证

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

`check` 验证两份清单、DSH 声明、技能头部和源码语法；`test` 运行单元测试与宿主、客户端冒烟；`test:package` 实际打包、解包并模拟 profile 按包名加载。打包检查需要系统提供 `tar`，当前 Windows 与 Ubuntu CI 环境均自带该工具。

新增流程测试应使用临时 `DSH_HOME`、`DSH_RETRO_DIR`、知识库与博客目录，并在结束后恢复环境。模型、Git 操作、浏览器打开器和 DOM 可使用测试替身。不要让自动测试读取个人会话、发布博客或启动真实浏览器。

## 修改约定

- JavaScript 使用 ESM、两空格缩进、UTF-8 和 LF；注释使用中文，协议名与 API 标识保持原文。
- 运行时源码位于 `dsh-retro/lib/`，正式分发清单位于根目录。更改版本或依赖时同步子目录兼容清单，并更新锁文件。
- 宿主入口保持 `apply(ctx, config)` 约定；客户端保留模块工厂、`./client` 导出与包级 `dsh.client` 声明。
- 文件操作复用已有路径限制。正式落库、规则采纳和博客发布继续由人工命令触发。
- 修复行为缺陷时覆盖实际输入、输出或副作用；避免仅复述内部实现的测试。
- API 或目录行为变化时同步更新英文 `README.md`、中文 `README.zh-CN.md` 与当前架构；两版 README 的命令、默认配置和适配限制应保持一致。
- 历史规划与执行记录仅在本地保留；公开文档集中维护使用说明、架构、变更记录和贡献指南。

## 提交与拉取请求

提交前运行相关检查与 `git diff --check`。提交说明可采用 `fix: 修复草稿取消后的写入`、`docs: 更新安装方式` 等中文描述。

PR 说明应交代具体问题、修改后的行为、执行过的验证及尚未验证的环境。附复现步骤时使用示例路径和模拟素材，不提交个人会话、知识库文件、配置或凭据。

问题与建议提交到 [GitHub Issues](https://github.com/StellatoL/retro/issues)。请给出 DSH、Node.js、操作系统版本、相关命令和脱敏后的错误信息。

项目使用 [MIT 许可](LICENSE)。
