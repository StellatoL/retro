# dsh-retro 本地兼容入口

本目录保存插件源码、配套技能和唯一的 bundle patch。正式 npm 分发清单位于仓库根目录，安装、配置、命令和开发说明统一见[项目 README](../README.md)。

原先指向本目录的本地 profile 链接仍可使用；本目录的 `package.json` 标记为 `private`，用于兼容原有安装，不单独发布。

新安装请使用：

```sh
dsh plugin --profile web add github:StellatoL/retro
```

本地开发请在仓库根目录运行 `npm ci --ignore-scripts` 和 `dsh plugin --profile web add .`。插件行名称保持 `dsh-retro`，以便 DSH 根据包元数据发现客户端。
