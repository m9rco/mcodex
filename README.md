# mcodex

用 npm 安装、连接自己的网关，再直接使用官方 Codex CLI。`mcodex` 自动管理本机转发进程和临时端口，省去安装独立客户端、写 TOML 和管理 systemd 的步骤。

## 安装与使用

需要 Node.js 22 或更新版本。支持 Linux x64、Linux ARM64 和 macOS ARM64。npm 包名为 `@m9rco/mcodex`，安装后的命令为 `mcodex`。

npm 修复版 **0.2.3** 包含工作目录与配置传递修复，沿用三个已验证的原生平台包 0.1.3。安装或升级后运行 `mcodex doctor --local` 核对实际版本。

```sh
npm install -g @m9rco/mcodex@0.2.3
mcodex doctor --local
mcodex
```

首次在终端运行 `mcodex` 或 `mcodex login`，会询问网关地址和连接 Token，验证成功后直接进入 Codex，无需再运行一次命令。以后运行 `mcodex` 就会直接连接并启动。Token 输入不会回显。这里使用网关签发的连接 Token，远端的订阅 OAuth 凭据由网关保管。

如果只想提前保存连接设置，可以运行：

```sh
mcodex login --no-launch --server wss://gateway.example/mlab-tunnel
mcodex
```

把示例地址换成自己的网关地址。`--no-launch` 只保存连接设置；默认的 `mcodex login` 在标准输入和输出都连接终端时，会复用已验证的连接启动 Codex。脚本或管道环境中的 `login` 只保存设置。

如果安装过旧的未加 scope 包，先运行 `npm uninstall -g mcodex`，再安装 `@m9rco/mcodex`，避免同名命令冲突。卸载旧安装包会保留 mcodex 的连接配置。

GitHub Release 一键脚本当前固定为 **0.2.1**，尚不包含 0.2.3 的目录修复；需要修复请使用上面的 npm 命令。该脚本识别平台、下载并核对 SHA-256，再用 npm 安装；同样需要 Node.js 22，连接设置保留：

```sh
curl -fsSL https://github.com/m9rco/mcodex/releases/download/v0.2.1/install.sh | sh
```

一键脚本会确认旧版全局包和命令属于本项目，再自动替换旧安装；不会使用 `--force` 覆盖其他程序的同名命令。

自动化环境可以从受保护的文件读取 Token：

```sh
mcodex login --no-launch --server wss://gateway.example/mlab-tunnel --token-file ./connection-token
mcodex doctor
mcodex exec "解释这个仓库的入口"
```

也支持 `--token-stdin` 从标准输入读取 Token。请勿把真实 Token 写进命令行参数、Git 仓库或 npm 包。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `mcodex login` | 在终端验证并保存连接，成功后直接进入 Codex |
| `mcodex login --no-launch` | 只验证并保存连接 |
| `mcodex engine status` | 显示实际 Codex 版本、来源、路径和兼容验证状态 |
| `mcodex engine check` | 只读检查官方 Codex 最新版，不安装或切换 |
| `mcodex doctor --local` | 离线检查本机引擎和转发程序，无需连接 Token |
| `mcodex doctor` | 检查安装和连接，不发起模型生成 |
| `mcodex ping` | 检测请求耗时、WSS 心跳 RTT 和逐跳观测 |
| `mcodex ping <WSS URL>` | 直接检测指定节点，保留已保存的连接设置 |
| `mcodex ping --server <WSS URL>` | 直接检测指定节点的另一种写法 |
| `mcodex ping --compare <WSS URL>` | 从当前机房比较两个属于同一网关的入口 |
| `mcodex logout` | 清除 mcodex 保存的连接信息 |
| `mcodex` | 启动官方 Codex 交互界面 |
| `mcodex exec "..."` | 执行官方 Codex 非交互任务 |
| `mcodex resume` | 恢复官方 Codex 会话 |

`login`、`logout`、`doctor`、`engine` 和包装器帮助命令由 mcodex 处理；其他命令和参数转交官方 Codex。模型、工作目录、沙箱和审批选项仍通过 Codex 参数控制，例如 `mcodex --model <模型名>`。

在项目目录运行 `mcodex` 即使用该目录；也可用 `mcodex --cd /home/pushaowei` 明确选择。mcodex 默认给模型的 shell 工具设置 `allow_login_shell=false`，避免登录配置中的 `cd` 在命令执行前把目录切回 `/root` 等主目录。已有终端环境会继承；需要重新加载登录配置时可显式传 `-c allow_login_shell=true`。`mcodex doctor --local` 显示启动目录、`HOME` 和 `CODEX_HOME`，便于区分工作区与用户配置目录；详细复现与限制见[目录漂移排查](docs/ENGINE-AND-CONTEXT.md#工作目录与-shell-启动配置)。

## 工作方式

```mermaid
flowchart LR
  A[本机官方 Codex CLI] -->|本机 HTTP / SSE| B[本机 Rust 转发进程]
  B -->|Token 认证 WSS 长连接| C[远端 MLab Gateway]
  C --> D[获授权的订阅模型]
```

Codex 的文件访问、命令执行和工具调用发生在运行 `mcodex` 的机器上。Node.js 只处理设置和进程管理；模型请求及流式响应仍由 Rust 转发。每次运行会自动建立连接，退出后停止本机转发进程并清理临时密钥。

mcodex 使用本机随机端口和临时 API Key，通过官方 Codex 的自定义模型提供商配置连接网关。它不修改 `HOME`、`CODEX_HOME`，也不改写已有的 Codex 配置。远端连接 Token 不传给 Codex 子进程。为保证 Codex 的本机请求直达转发端口，它只在 Codex 子进程中合并原有 `NO_PROXY`/`no_proxy` 排除项并追加 `127.0.0.1,localhost,::1`；已有 HTTP/SOCKS 代理变量和原生转发进程的上游代理保持原设置。

连接信息保存在 `${XDG_CONFIG_HOME:-~/.config}/mcodex`，目录权限为 `0700`，配置和密钥文件权限为 `0600`。mcodex 首次设置时读取你的网关地址，发布包不包含连接 Token。

## 性能与边界

主要收益是安装和使用更简单。请求的数据通路仍是原来的 Rust WSS 长连接，Node.js 不参与逐块转发。首次连接和启动进程仍有开销；模型生成速度取决于网络、网关和上游模型，套壳本身不会让模型生成更快。

此版本默认捆绑已验证的 `@openai/codex@0.163.0` 和各平台 Rust 转发程序。可通过 `MCODEX_CODEX_BIN` 显式使用独立安装的官方 Codex，让引擎与包装器分别升级；默认不会自动跟随系统 PATH 或最新版。见下方说明。安装过程中无需编译 Rust，也没有下载二进制的 `postinstall` 脚本。Windows 暂未支持。

Linux 本机工具需要系统允许官方 Codex 创建沙箱。Docker 默认限制可能阻止嵌套沙箱；具体测试条件与平台覆盖见 [验收记录](docs/VALIDATION.md)。

远端网关必须实现 MLab Gateway 的 WSS 协议，并已完成合法的订阅授权。使用仍需满足 OpenAI 账户、套餐和地区适用规则，mcodex 不改变这些资格。

Codex 的自定义提供商能力见 [官方配置文档](https://developers.openai.com/codex/config-advanced)，订阅访问接口见 [官方 Sign in with ChatGPT 文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## Codex 独立升级与长会话

```sh
mcodex engine status
mcodex engine check
# 显式选择已独立安装的官方 Codex，可使用绝对路径：
MCODEX_CODEX_BIN="$(command -v codex)" mcodex
# 使用捆绑版本：
unset MCODEX_CODEX_BIN
```

外部引擎必须是官方 Codex 可执行文件或其 JS launcher；不要指向 mcodex。指定尚未验证的版本时会提示兼容状态，用户选择仍被保留。`engine check` 只读取官方 npm 元数据，既不安装也不修改默认版本。维护者在更新默认版本前运行真实 CLI 的协议兼容测试；仅修改版本号不构成兼容验证。捆绑引擎关闭官方的启动升级提示，避免提示命令升级到另一个全局 Codex；显式外部引擎保留其自己的升级设置。

原生客户端与服务端 0.4.2 保留协商后的 v2 隧道，默认接受最大 16 MiB 请求体，硬上限 32 MiB，并在读取请求前限制同时占用的内存。旧端仍通过 v1 连接，保留 1 MiB 上限并明确返回 413。请求体字节上限与模型 token 上下文窗口不同；模型窗口仍由 Codex 元数据和上游决定，不会通过虚报窗口或截断会话绕过限制。

OpenSpec 必须在实际项目中初始化；新版 Codex 集成为 `.agents/skills/`，在项目根运行 `openspec init --tools codex` 后使用 `$openspec-propose "需求"`。已有集成升级用 `openspec update`。mcodex 保留原有工作目录、`HOME` 与 `CODEX_HOME`。版本隔离、错误分类和项目排查见 [引擎与上下文说明](docs/ENGINE-AND-CONTEXT.md)。

## 开发与分发

```sh
npm ci --omit=optional --ignore-scripts
npm test
```

主包为 `@m9rco/mcodex@0.2.3`。三个可选平台包为 `@m9rco/mcodex-linux-x64`、`@m9rco/mcodex-linux-arm64`、`@m9rco/mcodex-darwin-arm64`，版本均为 `0.1.3`，npm 根据系统和 CPU 安装对应包。

维护者用 `scripts/package-native.mjs` 生成平台包：Linux 资产来自 MLab Gateway `v0.4.2`，先校验冻结的 `SHA256SUMS` 摘要，再校验各资产和架构；macOS 包使用同版本 ARM64 可执行文件。发布源和清单摘要记录在 `scripts/native-release.json`；若指定其他构建，必须显式提供其清单 SHA-256。脚本不会访问用户连接配置。

```sh
node scripts/package-native.mjs --darwin-binary /path/to/mlab-gateway
npm pack ./packages/mcodex-linux-x64
npm pack ./packages/mcodex-linux-arm64
npm pack ./packages/mcodex-darwin-arm64
npm pack
```

npm 主包、原生包和 GitHub 归档分别维护版本；`scripts/github-release.json` 记录现有安装脚本对应的归档版本，npm 单独发版不移动已冻结的 GitHub 归档；只有对应 GitHub 资产就绪后，才同步此清单及两份安装脚本。`v0.2.1` Release 使用 `m9rco-mcodex-0.2.1.tgz` 与三个 `0.1.3` 原生 tarball，原生转发程序为 0.4.2。`scripts/install.sh` 是该 Release 的公开一键安装脚本，安装时校验主包和当前平台包，保留已有连接设置。不要发布本地配置、测试 Token、构建缓存或 OAuth 文件。架构和验收范围见 [提案](docs/PROPOSAL.md)，第三方组件见 [NOTICE](NOTICE)。

npm 发布后需等待公开下载并校验冻结 tarball，不能以提交回执或两步验证完成作为发行成功。运行 `node scripts/verify-published.mjs --directory <冻结目录>`；有限等待和状态排查方法见 [发布后验证](docs/RELEASE-VERIFICATION.md)。

连接等待分层：默认 SG 上游响应头预算 30 秒，隧道总预算 90 秒（包含授权刷新），mcodex 客户端预算 120 秒。SG 的超时会返回具体 504 错误；真正断线仍中断当前任务并为后续任务自动重连，不自动重放已提交任务。SG 自定义超时更长时，客户端预算也必须相应增加。

### 大请求、断线与诊断

0.4.2 修复大请求写入期间的假心跳超时：Ping 实际写出后才开始等待 Pong。独立的写入预算限制卡住的上传；取消 HTTP 请求后，排队或写入中的数据仍计入内存预算。失联后为后续请求重连，已提交生成不重放。

`mcodex doctor --local` 显示包装器、实际 Codex、原生包及二进制版本；`mcodex doctor` 再显示服务端版本、协商协议、有效请求体上限和安全的最近建连错误。默认 128 MiB 服务端原始请求预算中，64 MiB 用于连接帧预留，按每条 v2 隧道 16 MiB 计算可同时预留 4 条；`ping --compare` 会使用两条连接。达到预算返回 429；这与模型上下文、账户额度和单个请求体上限不同。

原生客户端 `write_timeout_seconds` 默认 30 秒，SG 默认心跳失联预算为 45 秒。单独扩大客户端写入预算不能突破服务端心跳限制；持续慢上传仍会有界失败。具体错误分类与排查见 [引擎与上下文说明](docs/ENGINE-AND-CONTEXT.md)。

### 延迟检测

运行 `mcodex ping`，通过已配置的 WSS 节点连续发送 5 次鉴权模型目录请求，显示每次耗时、失败次数以及最小/平均/最大耗时。使用 HK 入口时，测量包含 HK→SG 转发及网关处理，不代表纯网络 Ping 或模型生成耗时，不消耗模型生成额度。每次请求最多等待 3 秒；任意请求失败返回退出码 1。连接建立耗时单独显示，包含本地进程启动、TLS、鉴权和首次目录读取。登录及交互启动也会显示连接验证耗时。

也可以直接指定节点。下列命令都使用已有连接 Token，检测后保留当前配置：

```sh
mcodex ping wss://hk.0x06.cn/mlab-tunnel
mcodex ping --server wss://sg.0x06.cn/mlab-tunnel
```

原生客户端的心跳 RTT 来源于同一条持续 WSS 连接的匹配 Ping/Pong，保留最近 32 个样本及其年龄，重连后清空。从本机 Ping 写出到匹配 Pong 计算，包含所有中继及远端处理，排除本机 Ping 等待大请求写出的排队时间。`ping`、`doctor` 和交互启动使用同一遥测快照；未知、旧版原生包或暂时检测失败都显示为不可用，不把它们当成 0，也不阻断已验证的 Codex 连接。诊断只读取目录/健康状态，不能代替真实生成或工具验收。

如果入口配置了受鉴权的 `/mlab-probe`，还会显示 client→入口的 TCP 和 TLS 建连耗时，以及每个中继独立提供的下游响应头时间（TTFB）、可选的相邻 TCP/TLS 建连时间。最多 8 个连续跳段；样本数量与年龄单独显示。`downstream_header_ms` 来自 nginx 的 `$upstream_header_time`，包含到达下游健康响应头前的 TCP/TLS、其后中继和处理时间，属于累计量，不能把多跳时间相加，也不能与 WSS RTT 相减推算单跳网络 RTT。它不等同于完整响应传输耗时。nginx 的计时分辨率为 1 ms，测得 0 表示低于分辨率。探针禁止重定向，连接 Token 只发送到配置的、证书验证通过的入口。

### 路径比较

`mcodex ping --compare wss://sg.0x06.cn/mlab-tunnel` 比较已保存的入口与 SG。也可以显式指定两端：

```sh
mcodex ping --server wss://sg.0x06.cn/mlab-tunnel --compare wss://hk.0x06.cn/mlab-tunnel
mcodex ping --server wss://hk.0x06.cn/mlab-tunnel --compare wss://hk.0x06.cn/mlab-tunnel
```

比较时建立两条独立隧道，分别显示连接建立耗时，再交替发送每端 5 次只读探针；结果只统计这组配对请求。相同地址也可比较，输出将标明两条独立连接的差异。请使用能接受当前连接 Token 的网关入口。检测保留配置、不发起模型生成。建连耗时与稳定请求耗时不同，最少广域跳数也不等于最快路径。
