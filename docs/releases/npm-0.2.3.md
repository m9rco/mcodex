# npm 0.2.3 发行记录

2026-10-23（Asia/Shanghai）发布 `@m9rco/mcodex@0.2.3`，npm 记录的发布时间为 `2026-10-22T16:10:47.688Z`。`latest` 指向 0.2.3；默认官方 Codex 固定为 0.163.0，三个原生 npm 包保持 0.1.3、二进制保持 0.4.2。

此版本包含提交 `94179c8d08785a47b49d6c46fc287a9ce0167bb6` 的工作目录修复：默认禁用登录 shell、明确传递调用目录，并保留 `exec -c` 用户配置及包装器的网关配置。

## 发布与公开验证

先发布的 0.2.2 安装包包含完整 README，但直接读取 package.json 构造发布 manifest 时遗漏了 npm 展示页的 README 元数据。0.2.3 使用与 npm CLI 相同的 `pacote.manifest` 完整元数据读取方式补齐。两版 tarball 的文件集合相同，`bin/` 和 `src/` 逐字节一致；仅 package.json 和三份文档的版本号改变。

- npm 版本状态返回 `published`，匿名 metadata 与 `latest` 均为 0.2.3。
- 主包及三个原生包的公开下载均与各自冻结 tarball 摘要一致；原生包沿用公开的 0.1.3，没有重复发布。
- 公开 README 与冻结包的 README 完全一致（14,473 字节），包含 `npm install -g @m9rco/mcodex@0.2.3`。
- 主包 tarball：`m9rco-mcodex-0.2.3.tgz`，48,108 字节。
- SHA-256：`e05f6c168169b895359742b43043d97e3ca5bcd0f2eeb4bc2b8ee9d92f558f93`。
- SHA-512 integrity：`sha512-8y1DsytGZUBXdcYIdW5SLQCP/17sICTvAWf4bR78PPjJoSBhNP4BXOcHZ8LEgRl49qKHM7MfVi/uEiO9Sigl6w==`。

## 安装与测试

运行代码的 113 项 Node 测试全部通过；最终 0.2.3 的版本/安装入口契约测试 3/3 通过。目录修复的真实 Codex 工具验收见 [VALIDATION.md](../VALIDATION.md)。

macOS ARM64 从空 prefix、空 npm cache、独立 HOME 和空 npmrc 匿名安装精确版本 0.2.3，通过版本断言及 `doctor --local`。Linux ARM64 的同等隔离 Docker 验收针对 0.2.2 通过；最终 0.2.3 的运行文件与其完全一致。两次安装均确认官方 Codex 0.163.0、对应原生包 0.1.3、二进制 0.4.2 及本地完整性校验，不连接生产网关或调用模型。测试容器已删除，Colima 已恢复测试前停止状态。

本次只更新 npm 发行。GitHub 一键安装资产和两份安装脚本保持已存在的 v0.2.1，由 `scripts/github-release.json` 单独记录；需要工作目录修复应通过 npm 升级。
