# 首版验收记录

2026-10-11 验证 `mcodex@0.1.0`，固定官方 Codex CLI `0.162.1`，服务端协议版本 `0.3.3`。

npm 因未加 scope 的包名与既有名称相似而拒绝发布，正式主包改为 `@m9rco/mcodex@0.1.1`，命令仍为 `mcodex`，三个原生包版本保持 `0.1.0`。`0.1.1` 只调整包名、版本和升级安装流程。以下真实工具和 Docker 结果来自原 `0.1.0` tarball；新版公开安装与升级结果见下文。

- 自动测试覆盖私有配置权限、符号链接与硬链接拒绝、隐藏输入取消、参数透传、端口分配、密钥隔离、原生进程退出和信号超时清理。23 项通过。
- GitHub Actions 在 Ubuntu 与 Node.js 22 上完成安装、测试和包清单检查。
- 三个平台的 npm tarball 均完成校验和打包检查；无连接凭据或订阅 OAuth。
- macOS ARM64 实际连接服务端，官方 Codex 执行本机文件读取，准确返回未写入提示词的随机标记，退出码 0。
- 原生 Linux ARM64 Docker 内从 tarball 安装，同样完成连接、模型目录、真实本机工具调用和最终回复验证，退出码 0。
- Linux 单独验证了 Codex 的只读沙箱：读取文件成功，尝试写入被拒绝。

Linux Docker 工具测试的容器启用了 `CAP_SYS_ADMIN`，并放开该容器的 seccomp 与 AppArmor，以允许 Codex 创建嵌套 Bubblewrap 沙箱；没有宿主目录挂载，没有改主机 sysctl，也没有更改 mcodex/Codex 的默认沙箱。默认 Docker 限制会阻止此类嵌套沙箱。

Linux x64 在 ARM64 主机上的 QEMU 测试完成了安装、连接和模型回复。其本机工具沙箱遇到 QEMU 用户命名空间限制，因此不能据此宣称 x64 工具或性能已通过原生验证。需要原生 x64 Linux 进一步验证。

这些测试用于兼容性验收，没有进行模型吞吐或延迟基准，不能据此声称套壳提高模型速度。测试使用临时工作区，不把生产连接 Token 放入公开 CI。

维护者完成 `mcodex login --no-launch` 后，可运行 `node scripts/smoke-tools.mjs` 重复真实工具验收。这会消耗一个实际模型任务，包含工具调用所需的请求回合。

## 0.1.1 公开发行验收

- 主包 `@m9rco/mcodex@0.1.1` 与三个 `@m9rco/mcodex-<平台>@0.1.0` 均可匿名读取公开 npm metadata。四个版本的 `dist.integrity` 和 `dist.shasum` 全部匹配冻结 tarball，主包 `latest` 为 `0.1.1`。
- [GitHub v0.1.1 Release](https://github.com/m9rco/mcodex/releases/tag/v0.1.1) 的六个公开资产，API SHA-256 digest 全部匹配冻结文件和 `SHA256SUMS`；清单自身的 digest 也通过校验。旧 `v0.1.0` 标签仍指向原提交 `ac93184`。
- 原生 Linux ARM64 Docker 使用 Node.js `22.23.3`、npm `10.9.9`，在空 npm 配置、新缓存与独立全局安装目录中，匿名执行 `npm install -g @m9rco/mcodex@0.1.1`，退出码 `0`。正确的 ARM64 optional 原生包自动安装，AArch64 ELF、二进制 SHA-256、help 与版本均通过检查，CLI 为 `0.1.1`，原生转发程序为 `0.3.2`。首次安装遇到 registry metadata `E404`；公开版本 metadata 可读取后重试成功。
- 另一个无凭据、无宿主目录挂载的 ARM64 Docker 容器，从公开 GitHub 一键脚本完成旧未加 scope 包 `0.1.0` 到 scoped 主包 `0.1.1` 的升级。旧安装包已移除，连接配置和 Token 文件哈希保持一致，目录 `0700`、私有文件 `0600` 权限保留，CLI 与原生程序版本检查通过。
- 提交 `fff202e` 的 [GitHub Actions](https://github.com/m9rco/mcodex/actions/runs/38147916704) 通过 Ubuntu / Node.js 22 的安装、测试和包清单检查。

本次公开发行验收覆盖安装、资产完整性和升级；未连接网关，模型请求次数为 `0`。真实本机工具与沙箱覆盖仍以上述首版记录为准。已发布的 `v0.1.1` 标签和安装资产保持冻结，此文档作为后续验收记录更新。

## 0.1.2 登录后启动验收

2026-10-12，`npm run check` 通过，`npm test` 共 38 项通过。

- 交互终端执行 `mcodex login`，连接验证后直接启动 Codex；`--no-launch`、非终端及只有一侧为终端时只保存设置。
- 首次直接运行 `mcodex` 和交互 `login` 均复用同一个转发进程和模型目录验证，Codex 使用已验证的本机端点，没有第二次建立连接。
- 保留 Codex 参数和退出码；正常退出、验证阶段取消、Codex 阶段 SIGINT/SIGTERM 以及转发进程停止时，会清理临时进程和 candidate/runtime 目录。
- 状态提示只写 stderr，exec 的 JSON stdout 保持干净；连接 Token 不进入终端输出、Codex 参数或子进程环境。

上述新增流程测试使用本地模拟转发程序、Codex 执行器和 TTY，执行实际包装器代码；未访问生产 SG 或调用模型。原生转发程序、官方 Codex 版本和真实工具验收范围保持首版记录所述。

## 0.1.3 超时预算修复

客户端响应头等待增加到 120 秒，长于默认 SG 的 90 秒隧道预算；原生平台包仍为 0.1.0。配合 SG 0.3.4，后端响应超时会保留为结构化 504，而非被外层抢先终止并误报为连接中断 503。连接断开后的任务不自动重放。

## 0.1.5 遥测与兼容性验收

2026-10-15，主包 0.1.5、三平台原生包 0.1.1，固定官方 Codex 0.162.1、gateway 0.3.5。发行包由冻结二进制生成，原生清单和 macOS 二进制摘要固定在 `scripts/native-release.json`；各平台记录 binary SHA-256，lockfile 使用实际 tarball SHA-512 integrity。

- 包装器完整本地测试 62 项通过，覆盖真实 HTTP socket、登录与 Codex 进程监督、隐藏输入、私有文件权限、双通道比较、取消、遥测故障隔离及 JSON stdout。全部 JS 语法检查和公开安装脚本语法检查通过；这些流程测试中的外部 CLI 和 transport 是模拟执行器。
- 只在 Codex 子进程内合并 `NO_PROXY`/`no_proxy` 排除项并追加 loopback，保留原 proxy 变量及 native 上游环境。固定 CLI 的独立模拟验收曾证实，macOS 系统代理会截获未排除的 loopback 请求并返回 502；补排除后压缩、多轮、resume 和取消路径通过。
- SG gateway 已升级 0.3.5，服务 active。HK 与 SG 的只读探针鉴权返回 200；无 Token 返回 401。HK 观测头使用真实 hostname，TTFB 取 `$upstream_header_time`，相邻 TCP/TLS 建连取 `$upstream_connect_time`，不把响应头阶段尚未完成的完整传输时间作为观测。
- 新 macOS ARM64 native 0.3.5 在线探针读取到持续 WSS RTT 约 244 ms，以及 HK→SG 响应头约 114 ms、相邻 TCP/TLS 建连约 76 ms。它们来自不同测量边界，不能相加或相减推算其他 RTT。
- 开发机的交替目录请求比较为 HK 平均约 236.7 ms、SG 直连约 91.8 ms。该样本只证明开发机当时直连更快，不能证明用户另一 HK 机房的路径最短；应从实际客户端机器运行 `mcodex ping --compare <SG WSS URL>` 并在忙时重复。
- 经 HK 中转的固定官方 Codex 真实本机文件读取已准确返回临时文件内的随机标记，升级前后均通过（原生 client 0.3.5，升级后 server 0.3.5）。

当前支持范围是固定版本 Codex 的自定义 Responses HTTP/SSE 提供商；自定义持续 WSS 隧道不等同于原生 Responses WebSocket。模拟验收覆盖大文本、SSE、本地压缩、resume、取消并丢弃上游及无请求重放；上游不提供官方远程压缩端点时，固定 CLI 使用本地压缩。原生 Linux ARM64 Docker 从冻结 0.1.5/0.1.1 tarball 完成安装、鉴权、WSS RTT/逐跳探针及真实本机文件工具验证；x64 在 QEMU 下完成同版本安装、鉴权、WSS/逐跳检测，未据此声明 x64 原生工具或性能验收。ARM64 容器仅为嵌套 Codex 沙箱增加 CAP_SYS_ADMIN、放开容器 seccomp/AppArmor，没有宿主目录挂载。公开 gateway client v0.3.5 的匿名一键安装也在 ARM64 Docker 通过，初次下载出现两次连接超时后按安装器既有重试成功。真实长时间上下文、多任务工具和原生 x64 工具仍需各自验收，不能由上述模拟或单次工具通过推断。1 MiB 单请求边界和订阅访问资格仍适用；不宣称所有未来 Codex 版本与功能完整兼容。

## 0.1.5 公开安装与发布校验补记

2026-10-15，已发布的 v0.1.5 标签与安装资产保持冻结，以下为发行后的补充验收。

- GitHub v0.1.5 的六个公开资产 SHA-256 digest 与冻结文件一致。
- 主包 0.1.5、三个原生包 0.1.1 的匿名 metadata、latest 标签及下载 SHA-512 均与冻结 tarball 一致，四包完整公开发行检查通过。Linux x64 曾由 npm 状态接口返回 `validating`，重提时报暂存版本冲突；等待检查完成后状态为 `published`，再核对实际公开下载，不能把 HTTP 409 或提交回执作为成功。
- 干净 Linux ARM64 Docker 匿名从 npm 安装主包 0.1.5，自动获得 native 0.3.5，真实 HK 登录、模型目录与 doctor 遥测通过。
- 公开 GitHub 安装脚本在 x64 QEMU Docker 完成 0.1.4 到 0.1.5 升级，连接配置和 Token 文件哈希保持一致；该结果不属于 npm x64 安装验收。
- 另一干净 Linux x64 QEMU Docker 匿名从 npm 安装主包 0.1.5，自动获得 x64 原生包 0.1.1 和 native 0.3.5，依赖解析、原生程序版本和包装器帮助检查通过；未据此扩展 x64 原生工具或性能覆盖范围。
- 增加匿名发行校验脚本，支持先验证三个平台包、再发布主包、最后验证完整四包。真实 HTTP fixture 覆盖等待后可用、错误下载内容与等待超时；真实发行目录检查先准确报告 x64 未公开并超时，在 npm 检查完成后四包检查通过。
- CLI 流程测试的可选 HTTPS 探针改为本机随机端口模拟，避免外部 DNS 等待与测试等待上限同时达到 3 秒导致偶发超时；生产逻辑和测试等待上限不变。最终完整测试 66 项通过，JS 语法及差异检查通过。

发行检查方法见 [发布后验证](RELEASE-VERIFICATION.md)。测试容器已删除，未保留测试连接凭据。
