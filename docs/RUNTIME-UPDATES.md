# 独立运行包与稳定启动器

0.3.0 是一次 npm 迁移：`bin/mcodex.js` 进入稳定启动器，原 CLI、provider、隧道、诊断与固定依赖构成运行包。npm 保留完整基线，不依赖运行包服务才能启动。后续常规修复由 GitHub Release 分发，无须重新发布主包或三个原生 npm 包。

## 用户操作

`mcodex runtime status` 显示启动器与运行包；`update --check` 只读检查签名通道；`update` 下载并验证后切换；`rollback` 选择上一版本；`rollback --bundled` 直接回到随 npm 安装的基线，也可修复损坏的选择元数据。诊断命令同时报告启动器与运行包版本。

正常启动不进行在线更新检查。连接设置仍由 `MCODEX_CONFIG_DIR` / XDG_CONFIG_HOME 管理，运行包位于 `${XDG_DATA_HOME:-~/.local/share}/mcodex/runtime`，可通过 `MCODEX_RUNTIME_DIR` 指定。不会改写 HOME、CODEX_HOME、全局 Codex 或已有连接配置。

公开下载遵循 HTTP_PROXY / HTTPS_PROXY / NO_PROXY（也支持小写变量）。配置 HTTP 代理时，下载工作进程使用 Node 的环境代理支持，要求 Node 支持 `--use-env-proxy`（本次在 Node 22.23.1 验证）；它不会改变主进程的网络设置或本机网关探测。只有 SOCKS ALL_PROXY 的环境需要另外提供 HTTP(S) 代理入口。

## 发行和信任

- `scripts/runtime-release.json` 独立管理运行包、官方 Codex、原生程序版本；Codex 必须已列入运行包的完整兼容性验收清单。
- 每个平台包含 JS 运行代码、精确版本官方 Codex 和原生转发程序；用户更新时不执行 npm install 或安装脚本。
- `runtime-v<VERSION>` 保存不可变平台归档；`runtime-stable/channel.json` 是可更新的 Ed25519 签名通道，包含启动器 API、版本、有效期和所有文件的大小/摘要/执行权限。
- npm 启动器内置公钥。下载限制为该仓库的精确 GitHub 版本归档；重定向只接受公开 GitHub 下载 CDN，不发送连接 Token 或 npm 凭据。
- 先校验签名、归档大小与 SHA-256，再使用受限 ustar 解压器拒绝链接、特殊文件、重复路径和越界路径。逐文件校验后执行离线 `doctor --local`，最后原子更新选择文件。
- 已安装版本可在通道签名过期后继续离线使用；获取新版本必须使用未过期通道。启动时重新检查本地签名和完整文件摘要，损坏时在执行命令前回退到上一可用版本或基线。
- 记录最高已接受版本与归档摘要，远端不能降级或替换同版本文件；本地显式 rollback 保留此记录。损坏归档重装到新目录，现有目录不就地覆盖或删除。
- 不自动重试已经执行的 Codex 命令。并发更新由独占锁阻止；进程被强制终止后，确认没有更新进程再删除缓存内 `.update.lock`。失败留下的 `.download-*` 可在无更新进程时清理。
- 同一用户可修改自己的缓存和状态，不把本地状态视为防御该用户本人的安全边界。缓存只允许当前用户拥有且不可被其他用户写入的路径。

## 两条发行流水线

`.github/workflows/publish-runtime.yml` 在三个原生平台上构建，执行测试、真实依赖健康检查和真实 Codex 工作目录检查，然后由 `runtime-release` 环境签名并上传。只有三个平台全部通过，才推进稳定通道。重试失败的发布时复用原始构建资产；已存在版本必须与冻结摘要相符，不覆盖归档。

原生程序默认复用现有 npm 0.1.3；升级时可在 `nativeSources.<platform>` 配置 gateway GitHub Release 的 `url` 和 `sha256`。原始二进制直接使用；单文件 tar.gz 额外设置 `archiveMember: "mlab-gateway"`。更新 nativeVersion/nativePackageVersion 并提供三个平台固定资产即可，不需要把这些内部平台包再次发布到 npm。`--native-directory` 支持维护者本地构建输入。

`.github/workflows/publish-npm.yml` 使用 `npm-release` 环境与 npm OIDC，只在需要改变启动器时运行。预检确保 tag/manifest/lock 一致、版本未发布、README 和完整基线存在、无敏感文件、原生依赖与锁文件摘要相同。使用标准 `npm publish <冻结归档>`，发行后核对公开 README、latest 与下载摘要。

手动运行的 publish 默认 false，只生成可审查资产。`launcher-v*` / `runtime-v*` 标签或显式 publish=true 才进入发布任务。普通 push、PR 和文档更新不会发布。

## 首次启用的外部配置

代码中的工作流本身不会自动建立以下权限；必须由仓库和 npm 维护者完成后才能发行。

1. 在 GitHub 建立 `runtime-release` 环境，仅允许 main 分支和 runtime-v* 标签；保存 `MCODEX_RUNTIME_SIGNING_KEY` 环境 secret。私钥通过受保护输入传递，不进入仓库、构建归档或日志。此次生成的私钥位于维护者本机 `~/.config/mcodex-release/runtime-ed25519.pem`（0600）；公钥已经固定在 `src/runtime-policy.json`。该 key 的备份、轮换和丢失处理属于维护者发行职责；更换启动器信任根需要一次 npm 发版。
2. 在 GitHub 建立 `npm-release` 环境，仅允许 main 和 launcher-v*。在 npm 主包设置 Trusted Publisher：用户 m9rco，仓库 mcodex，工作流 publish-npm.yml，环境 npm-release，允许直接 npm publish。不会申请原生平台包的发布权限，也不存长期 npm 写 Token。
3. 先发布并公开校验 runtime-v0.3.0，再发布 launcher-v0.3.0。已有 0.2.x 用户完成这一次 npm 升级后，后续使用 mcodex update。
4. 保留 npm/GitHub 原有冻结版本，历史 install.sh 仍指向有完整资产的 v0.2.1；不将该安装脚本改为不存在的迁移资产。

npm Trusted Publishing 需要受支持的 npm/Node 和 GitHub-hosted runner，详见 [npm 官方文档](https://docs.npmjs.com/trusted-publishers/)。运行包签名采用独立密钥，不依赖用户的 npm 登录状态。
