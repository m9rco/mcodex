# mcodex

用 npm 安装、连接自己的网关，再直接使用官方 Codex CLI。`mcodex` 自动管理本机转发进程和临时端口，省去安装独立客户端、写 TOML 和管理 systemd 的步骤。

## 安装与使用

需要 Node.js 22 或更新版本。支持 Linux x64、Linux ARM64 和 macOS ARM64。

```sh
npm install -g mcodex
mcodex login --server wss://gateway.example/mlab-tunnel
mcodex
```

把示例地址换成自己的网关地址。`login` 会交互读取连接 Token；输入内容不会回显。这里使用网关签发的连接 Token，远端的订阅 OAuth 凭据由网关保管。

也可直接从公开 GitHub Release 安装，适用于 npm 主包尚未发布或需要固定安装资产的情况。脚本识别平台、下载并核对 SHA-256，再用 npm 安装；同样需要 Node.js 22：

```sh
curl -fsSL https://github.com/m9rco/mcodex/releases/download/v0.1.0/install.sh | sh
```

自动化环境可以从受保护的文件读取 Token：

```sh
mcodex login --server wss://gateway.example/mlab-tunnel --token-file ./connection-token
mcodex doctor
mcodex exec "解释这个仓库的入口"
```

也支持 `--token-stdin` 从标准输入读取 Token。请勿把真实 Token 写进命令行参数、Git 仓库或 npm 包。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `mcodex login` | 保存并验证网关地址和连接 Token |
| `mcodex doctor` | 检查安装和连接，不发起模型生成 |
| `mcodex logout` | 清除 mcodex 保存的连接信息 |
| `mcodex` | 启动官方 Codex 交互界面 |
| `mcodex exec "..."` | 执行官方 Codex 非交互任务 |
| `mcodex resume` | 恢复官方 Codex 会话 |

`login`、`logout`、`doctor` 和包装器帮助命令由 mcodex 处理；其他命令和参数转交官方 Codex。模型、工作目录、沙箱和审批选项仍通过 Codex 参数控制，例如 `mcodex --model <模型名>`。

## 工作方式

```mermaid
flowchart LR
  A[本机官方 Codex CLI] -->|本机 HTTP / SSE| B[本机 Rust 转发进程]
  B -->|Token 认证 WSS 长连接| C[远端 MLab Gateway]
  C --> D[获授权的订阅模型]
```

Codex 的文件访问、命令执行和工具调用发生在运行 `mcodex` 的机器上。Node.js 只处理设置和进程管理；模型请求及流式响应仍由 Rust 转发。每次运行会自动建立连接，退出后停止本机转发进程并清理临时密钥。

mcodex 使用本机随机端口和临时 API Key，通过官方 Codex 的自定义模型提供商配置连接网关。它不修改 `HOME`、`CODEX_HOME`，也不改写已有的 Codex 配置。远端连接 Token 不传给 Codex 子进程。

连接信息保存在 `${XDG_CONFIG_HOME:-~/.config}/mcodex`，目录权限为 `0700`，配置和密钥文件权限为 `0600`。mcodex 首次设置时读取你的网关地址，发布包不包含连接 Token。

## 性能与边界

主要收益是安装和使用更简单。请求的数据通路仍是原来的 Rust WSS 长连接，Node.js 不参与逐块转发。首次连接和启动进程仍有开销；模型生成速度取决于网络、网关和上游模型，套壳本身不会让模型生成更快。

此版本固定依赖 `@openai/codex@0.162.1`，并捆绑各平台的 Rust 转发程序。安装过程中无需编译 Rust，也没有下载二进制的 `postinstall` 脚本。Windows 暂未支持。

Linux 本机工具需要系统允许官方 Codex 创建沙箱。Docker 默认限制可能阻止嵌套沙箱；具体测试条件与平台覆盖见 [验收记录](docs/VALIDATION.md)。

远端网关必须实现 MLab Gateway 的 WSS 协议，并已完成合法的订阅授权。使用仍需满足 OpenAI 账户、套餐和地区适用规则，mcodex 不改变这些资格。

Codex 的自定义提供商能力见 [官方配置文档](https://developers.openai.com/codex/config-advanced)，订阅访问接口见 [官方 Sign in with ChatGPT 文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## 开发与分发

```sh
npm ci --omit=optional --ignore-scripts
npm test
```

主包为 `mcodex`。三个可选平台包为 `@m9rco/mcodex-linux-x64`、`@m9rco/mcodex-linux-arm64`、`@m9rco/mcodex-darwin-arm64`，npm 根据系统和 CPU 安装对应包。

维护者用 `scripts/package-native.mjs` 生成平台包：Linux 资产固定来自已公布的 MLab Gateway `v0.3.2`，下载后校验固定 SHA-256；macOS 包使用提供的 ARM64 可执行文件。脚本不会访问用户连接配置。

```sh
node scripts/package-native.mjs --darwin-binary /path/to/mlab-gateway
npm pack ./packages/mcodex-linux-x64
npm pack ./packages/mcodex-linux-arm64
npm pack ./packages/mcodex-darwin-arm64
npm pack
```

先发布三个平台包，再发布主包。不要发布本地配置、测试 Token、构建缓存或 OAuth 文件。架构和验收范围见 [提案](docs/PROPOSAL.md)，第三方组件见 [NOTICE](NOTICE)。
