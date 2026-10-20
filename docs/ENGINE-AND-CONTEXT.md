# Codex 引擎、项目技能与长上下文

## 独立维护

mcodex 有三个分别维护的组件：Node 包装器、官方 Codex 引擎、Rust 隧道客户端。SG 服务端独立升级，HK 仅转发 WSS。系统全局 `codex` 更新不会改变 npm 包内固定的 Codex 依赖。

默认使用包内已验证的 Codex；设置 `MCODEX_CODEX_BIN` 才会使用外部引擎。变量接受官方可执行文件或 JS launcher 的路径，不接受 mcodex 本身。`mcodex engine status` 显示实际版本、来源、路径和兼容状态。`mcodex engine check` 只读取官方 npm 元数据，不自动更新、不改变用户选择，也不需要网关 Token。

```sh
npm install -g @openai/codex@0.163.0
MCODEX_CODEX_BIN="$(command -v codex)" mcodex engine status
MCODEX_CODEX_BIN="$(command -v codex)" mcodex
# 回到包内默认引擎：
unset MCODEX_CODEX_BIN
```

这让你可以先独立试用新 Codex，再决定是否切换。未验收的显式外部版本会提示未知兼容状态，不能视为已通过协议测试。每次 mcodex 默认引擎更新前，维护者需运行真实官方 CLI 的工具调用、SSE、本地压缩、resume 和取消测试；启动版本检查只是其中一部分。公开仓库的引擎工作流检查实际启动，私有网关仓库负责完整协议矩阵。没有自动安装或自动激活最新版本的机制。捆绑引擎启动时覆盖 `check_for_update_on_startup=false`，避免官方提示的 `npm install -g @openai/codex` 更新到无关的全局安装；显式外部引擎不覆盖该设置。

私有仓库的手动候选工作流接受明确的官方版本，在隔离 npm 安装后校验实际 `--version`，再运行工具调用、SSE、本地压缩、resume、取消和无重放测试。候选通过也不会自动改默认版本或兼容白名单，维护者仍需审核并提交。公开仓库的引擎工作流只检查版本识别和启动，不能代替完整协议测试。

## OpenSpec

OpenSpec 的全局 CLI 安装与项目集成是两件事。项目没有 `openspec/` 和 `.agents/skills/openspec-*` 时，仅升级 CLI 不会生成项目技能。

在你实际使用的项目根目录运行：

```sh
openspec --version
openspec init --tools codex
openspec list --json
```

已有 OpenSpec 集成时运行 `openspec update` 更新项目文件。新版 Codex 集成使用 `.agents/skills/`；CLI/IDE 里调用 `$openspec-propose "需求"`、`$openspec-apply-change` 等技能，桌面可从 Skills 选择。旧全局 `/openspec-proposal` 等命令可能引用已不存在的 `openspec/AGENTS.md` 或 `project.md`，应迁移到当前技能入口。

mcodex 保留调用时的工作目录、`HOME` 和 `CODEX_HOME`，不创建隔离的用户技能目录。如果某个项目仍看不到技能，先确认当前目录和生成文件，再重启该项目的 Codex 会话。不要在错误的上层目录批量初始化无关项目。

依据：[OpenSpec 支持工具](https://github.com/Fission-AI/OpenSpec/blob/main/docs/supported-tools.md)、[迁移说明](https://github.com/Fission-AI/OpenSpec/blob/main/docs/migration-guide.md)。

## 长上下文错误分类

请求体字节数和模型上下文 token 数不能互换。大型工具输出、图片或长历史可能首先撞到传输上限；这发生在模型推理之前。

| 错误 | 排查方向 |
| --- | --- |
| 413 / `request_body_too_large` | 本机、协商协议或服务端的请求体字节上限 |
| 429 / 内存 admission budget 错误 | 同时传输的大请求占满内存预算，减少并发或稍后重试 |
| 上游 400 / `context_length_exceeded` | 模型实际 token 窗口、压缩行为、单项工具输出过大 |
| 503 / `Server connection interrupted` | WSS 连接中断；已提交请求不会自动重放 |
| 504 / 上游响应头或流超时 | 对照服务端和客户端对应阶段的超时预算 |

原生 0.3.5 的 v1 隧道只接受 1 MiB 请求体。0.4.1 增加协商后的 v2：默认 16 MiB，硬上限 32 MiB，并在读取请求体前限制并发占用。旧客户端连接新服务端仍用 v1；新客户端连接旧服务端也保留 v1 的 1 MiB 上限，并给出明确 413。两端都升级才能使用扩大后的上限。

放宽字节上限不会扩大模型本身的上下文窗口。mcodex 不强设 `model_context_window` 或压缩阈值，不截断消息，也不在连接中断后重放可能已执行的工具请求。自定义 loopback provider 在已验收的 Codex 版本中使用本地压缩；它与公共 API 的 remote compact 接口不同，不能只添加一个路径就宣称兼容。

在 0.163.0 的真实 app-server 验收中，单条超过 1,048,576 字符的文本输入触发了官方 `input_too_large`，请求尚未进入网关。这是该输入接口的字符限制，不能与隧道字节上限、整个会话的 token 窗口混为一谈。

出现问题时保留脱敏后的完整状态码、错误码、实际引擎版本、原生版本和发生阶段即可；不要提交连接 Token、OAuth 文件、完整请求历史或私有仓库内容。`mcodex doctor --local` 无需连接 Token，`mcodex doctor` 可继续检查网关和只读诊断。

依据：[官方配置项](https://learn.chatgpt.com/docs/config-file/config-reference)、[官方变更记录](https://learn.chatgpt.com/docs/changelog)。

## 0.4.2 的上传与预算修复

已复现旧客户端在大请求慢写入时误断线：Ping 还排在请求数据之后，就开始计算等待 Pong 的期限，健康连接最终变成 503。0.4.2 将排队、发送和成功写出分开计时，只有实际写出的 Ping 才等待 Pong；写入本身有独立的有限预算，真实丢失 Pong 仍会触发重连。心跳 RTT 排除 Ping 在本机发送队列等待大请求的时间，仍包含网络、中继与远端处理。

客户端取消 HTTP 请求时，排队或正在写出的原始请求数据仍计入共享内存预算，直到写出或丢弃后才释放。预算不是整个进程 RSS 的保证，JSON 编解码、TLS、系统 socket 及其他元数据还有额外开销。

原生客户端配置 `write_timeout_seconds=30`，SG 默认的心跳失联预算为 45 秒。不要仅增大客户端写入预算就预期无限慢的上传可以继续；两端失联预算和实际带宽也必须协调。此修复不重放已经提交的生成，也不更改模型 token 窗口或增加订阅额度。

## 安装来源与错误定位

本次修复版：mcodex 0.2.1、原生 npm 包 0.1.3、原生二进制和 SG 服务端 0.4.2、默认官方 Codex 0.163.0。npm 旧 latest 0.1.5 使用原生 0.3.5（1 MiB）；GitHub 有新 Release 不代表 npm 已发布。优先按 README 的版本化 GitHub 安装脚本升级，并运行 `doctor --local` 核对实际安装。

`doctor` 和启动失败只显示白名单内的错误阶段、错误码、状态及可用的重试时间，不输出远端原始响应、请求历史或 Token。握手 429 通常需要先检查同一网关的隧道数量和帧预留预算；默认 128 MiB 原始请求预算分出 64 MiB 给连接帧池，16 MiB v2 隧道可预留 4 条，并非 64 个模型并发都能开独立连接。每个 mcodex 进程会建立自己的隧道，比较探测同时使用两条。不要把握手 429 当作 OpenAI 模型速率限制；上游 429 还需核对上游错误本身。

目前没有取得名为 “Loog limit” 的原始错误。已证实并修复的是分发旧版本、慢上传假心跳超时及取消时预算过早释放；不能据此断言所有含 limit 的错误都来自同一原因。
