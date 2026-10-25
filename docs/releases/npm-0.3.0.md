# npm 0.3.0 发行记录

2026-10-25 发布 `@m9rco/mcodex@0.3.0`，npm 公开时间为 `2026-10-25T03:54:38.488Z`。`latest` 指向 0.3.0；默认官方 Codex 保持 0.163.0，三个原生 npm 包保持 0.1.3、二进制保持 0.4.2。

此版本将稳定启动器与日常运行包分离，加入 `mcodex runtime status`、`mcodex update --check`、`mcodex update` 和 `mcodex rollback`。用户通过 npm 升级一次后，后续功能与引擎更新可以使用 GitHub Release 上的已签名运行包；更新验证失败时保留当前版本。运行包 0.3.0 的三平台验收见 [运行包发行记录](runtime-0.3.0.md)。

## 自动发布与公开验证

维护者完成 npm 身份验证后建立并回读核验 Trusted Publisher，绑定范围为包 `@m9rco/mcodex`、GitHub 仓库 `m9rco/mcodex`、工作流 `publish-npm.yml` 和环境 `npm-release`，允许直接发布。工作流使用 GitHub OIDC 与标准 npm CLI，没有保存长期 npm token。

- [正式发行工作流 40159725805](https://github.com/m9rco/mcodex/actions/runs/40159725805) 通过；冻结源码提交为 `303aa64a71b66ac4101b2066c974d47f38a0c562`。
- 133 项 Node 测试、语法检查、发布预检、三个既有原生包的匿名摘要校验与标准 npm dry-run 全部通过。
- npm 异步处理后，匿名公开 metadata、`latest` 和 README 均与冻结包一致；主包及三个原生包的公开下载与冻结归档摘要完全一致。
- [npm 公开版本](https://www.npmjs.com/package/@m9rco/mcodex/v/0.3.0) 带有 GitHub Actions 来源证明；[Sigstore 记录](https://search.sigstore.dev/?logIndex=3450502083)。
- 主包 `m9rco-mcodex-0.3.0.tgz`：59,811 字节。
- SHA-256：`93919e6d4a0379e4d84adc7b1f3ccd90bb8b2a27a79e2ce8204a77bd0e48a310`。
- SHA-512 integrity：`sha512-+pKzzb5XnHLbUFM7px8AhKPUcABFuKdYMzvbJvVVShF1JClYwlmmrgYg/6acRV+t196Ueky7TMsuGmStFACcnA==`。

## 公开安装验收

macOS ARM64 从空 prefix、空 npm cache、独立 HOME 和空 npmrc 匿名安装精确版本 0.3.0，未携带 npm 或模型凭据。版本断言、`--version`、`doctor --local`、`runtime status` 和 `update --check` 全部通过，确认官方 Codex 0.163.0、原生包 0.1.3、二进制 0.4.2 及本地完整性匹配。签名通道检查显示可将同版本 0.3.0 安装为独立运行包，未连接生产网关或调用模型。

生产签名运行包的实际安装、健康检查、回退及缓存恢复已在隔离目录中通过，详见运行包发行记录。发布记录位于主包打包白名单之外，其后续补充无需再次发布 npm。

## 升级入口

```sh
npm install -g @m9rco/mcodex@0.3.0
mcodex update --check
mcodex update
```

运行包下载、逐文件完整性检查和本地健康检查全部通过后才切换当前版本。`mcodex rollback` 可离线回退到上一版本，`mcodex rollback --bundled` 可恢复 npm 基线。普通运行不会自动下载更新。
