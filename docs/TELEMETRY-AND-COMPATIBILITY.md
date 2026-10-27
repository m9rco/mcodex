# 延迟观测与 Codex 兼容性工作记录

状态：实现与本地资产已冻结，线上探针及初次真实工具验证通过；发行包与长会话验收另见 VALIDATION.md。2026-10-15。

## 完成标准

1. 客户端同步显示连接建立、已建立 WSS 心跳 RTT、实际请求耗时；这些量分开，不能相加或相减伪造逐跳 RTT。
2. client→HK、HK→SG 等跳段都有来自测量节点的明细，标注测量方式、样本数量、样本年龄、失败状态。未知不能显示为 0。
3. 能比较客户端所在机房的 SG 直连与 HK 中转；以真实 RTT/失败率证明选择，不能用地域或单次 traceroute 推断最短路径。
4. 对固定官方 Codex 版本验证 SSE、工具、多轮、取消、并发、重连、超时、上下文压缩、必要请求头、模型目录及沙箱；新版本需重新验证。
5. 实际部署服务端、HK 观测和原生平台包，发布包装器，使用公开安装流程完成真实验证。

## 开始本次改动时的基线

mcodex 基线 dbc1028，原生 gateway 基线 f946997 / 0.3.4。原生协议 v1 只允许 GET models、POST responses、GET healthz，不传客户端请求头。包装器固定 Codex 0.162.1，主动关闭其原生 Responses WebSocket，请求/流重试为 0。现有 v1 WSS 是自定义隧道，不能等同于官方 Responses WebSocket。

这些事实证明常规 HTTP SSE 可以经过隧道，也证明其他路径和头部尚需逐项调查。例如上下文压缩需要核对固定 CLI 的实际请求；不能只凭简单工具调用已通过，就声明长会话完整支持。真实兼容性历史见 VALIDATION.md。

当前拓扑：Codex → 本机 HTTP facade → 一个 WSS → HK HAProxy TCP 分流 → HK nginx TLS 终止 → SG nginx TLS 终止 → 同进程隧道路由/订阅后端 → 上游。SG backend 的 Router::oneshot 不经过额外本地 HTTP 网络跳。HK HAProxy 为复用现有 443/V2Ray 增加一次本机分流，不是额外广域跳。可去掉本机分流但会牵涉现有业务，必须以测量证明收益后再决定。

最少广域跳是 client→SG。由于用户机房到 SG 路由可能绕行，最少跳数不等于最低延迟。必须从用户实际机器测直连与中转，不能用开发机结果代替。

## 已实现的观测基础

原生客户端 `/diagnostics` 为 loopback-only、由本机 Bearer key 鉴权，schema_version=1。Connection 独立保存最近 32 个匹配 Ping/Pong 的单调时钟 RTT、统计和样本年龄，重连后重置；断开不返回旧样本。测量包含控制队列和所有中继，不依赖各机器时钟同步。未观测跳段返回 hops=[]，不能虚构数据。mcodex 读取该接口，兼容旧 transport 的 404，用户取消仍终止检测。

## 逐跳实现与剩余验证

HK 必须有本机采集能力。优先用既有 nginx 诊断 location 配合受鉴权的 SG 只读探针：HK 的 `$upstream_header_time` 表示到达 SG 健康响应头的时间（TTFB），包含 TCP/TLS 和 SG 处理；若取 `$upstream_connect_time`，必须标为 TCP/TLS 建连而非持续连接 RTT。响应头阶段不能使用尚未完成的 `$upstream_response_time`，该值可能为 `-`。通过固定源站和严格 TLS 校验访问，不提供任意目标参数，防止 SSRF，不存储生产连接 Token。返回受信任的节点标识及明确单位，限流并限制响应长度。

客户端的 client→HK 探针必须明确 TCP 建连、TLS 建连或应用层往返；不能与 HK→SG 不同时间的样本相减推算。多跳由各节点独立观测组成，按顺序输出，保留观测来源和年龄，不输出 OAuth、鉴权头、内部日志或完整私有源站配置。

HK 观测结果通过包装器统一快照呈现在显式 `ping` / `doctor` 中；普通启动和登录不等待独立探测，也不向 Codex JSON stdout 注入状态文本。探针不生成模型内容，暂态失败不能中断已有生成。

## 官方参考

- https://learn.chatgpt.com/docs/config-file/config-advanced
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server

官方参考是接口依据，不是本项目已完成验收的证明。

## 本轮进展

已实现独立 HTTPS 探针、最多 8 跳连续观测解析、单位与来源标注、私有 Token 文件重新校验、禁止重定向、3 秒总期限和 8 KiB 响应上限。统一快照在 `ping` / `doctor` 中显示；探针失败不会使已连接的生成通道失效，取消仍正常传播。HK/SG nginx location 模板及部署约束见 gateway 仓库 docs/HOP-TELEMETRY.md。

2026-10-27 启动路径调整：普通 `mcodex`、`exec`、首次设置和 `login`（含 `--no-launch`）在连接验证成功后不再采集可选遥测或发起额外 HTTPS 冷连接，只保留连接进度与本地组件版本。需要心跳、协商上限、服务端版本和分跳探测时显式运行 `mcodex doctor` 或 `mcodex ping`。有本地模型目录缓存的普通启动可以读取本机认证就绪信息，这与独立网络探测不同；登录及显式诊断仍从网关读取目录。该调整移除额外诊断等待，不改变网关鉴权、推理请求或取消行为，也不宣称消除了公网重传。

此前受限权限下，29 项不需要端口监听的 Node 测试通过；原生匹配 Pong/窗口测试、协议测试及 Clippy 通过。SSH 固定 IP 当时返回 Operation not permitted，未部署配置或执行线上测量。固定官方二进制运行版本确认是 codex-cli 0.162.1；字符串分析不是接口行为证据，不能据此声明兼容完整的压缩接口。

新增 `ping --compare <WSS URL>`：两个已鉴权隧道交替探测，比较已建立连接的请求耗时而非不等价的冷启动时间；失败样本不生成路径推荐，不自动切换端点。逐跳头新增可选的相邻 TCP/TLS 建连时间；下游响应头时间明确标为累计量，多级中继不能把它当作单跳 RTT。开发机在线比较已记录在 VALIDATION.md；用户实际客户端机房仍需独立测量。

## 2026-10-15 包装器本地验收

完整 `npm test` 共 62 项通过，`npm run check` 覆盖全部源模块与构建脚本，公开安装脚本通过 `sh -n`。以下覆盖运行实际包装器和 HTTP socket 的流程，不属于真实模型或生产线路验收：

- 缺少、异常或格式错误的可选诊断不阻止已经验证的 Codex 启动；用户取消仍终止诊断并清理转发进程。
- 登录、首次启动、TTY exec 与非 TTY exec 保留官方 CLI 的参数、退出码和 JSON stdout；Token 不进入输出、Codex 环境或参数。
- 0.1.5 的路径比较启动两个独立隧道，交替取样并清理两个进程；该版会拒绝不安全或与当前地址相同的 compare URL。0.1.6 的同地址行为调整见下文。
- 诊断快照只保留已知数值字段，不传递任意元数据；断线后的 RTT 清除，旧原生版本与探针失败明确区分。
- 最多 8 跳的探针头拒绝不连续链、循环、非规范编号和超过累计时间的相邻建连值。Nginx 小于 1 ms 分辨率的合法 0 与未知保持区别。
- Codex 子进程合并原有两种大小写的代理排除列表，追加三个 loopback 名称；保留原有代理变量、排除项和 native 上游环境。实际子进程环境检查只允许新增本机 API key 与这两个排除变量，Token 不进入参数或环境。

本地发行资产为主包 0.1.5、三平台原生包 0.1.1，统一使用 gateway 0.3.5。冻结原生清单摘要与 macOS 二进制摘要记录在 `scripts/native-release.json`，各平台包和 lockfile 记录实际资产完整性。线上与真实 Codex 验收结果由发布阶段另行记录，不以本节的本地通过结果代替。

## 已解除阻塞与最终证据

执行环境已恢复网络；HK 密钥文件由用户恢复。SG gateway 0.3.5 active，HK/SG probe 鉴权 200、缺 Token 401，保留原 V2Ray 业务。模型与额度响应头已补齐、仅 Codex 子进程合并 loopback NO_PROXY，普通 SSE、本地压缩、resume、取消的固定官方CLI模拟验收通过；SG真实文件工具在升级前后通过，ARM64 Docker完整真实工具通过，x64模拟架构的鉴权/遥测通过。具体证据及边界见 VALIDATION.md。

结构上直接连接 SG 最少一个广域连接；保留 HK 中继时 client→HK→SG 是两个广域连接，SG隧道→订阅backend为同进程Router调用，不增加本地HTTP网络跳。HK HAProxy的本机SNI分流是为复用V2Ray公网443，未增加广域节点；移除它会改变既有站点布局，当前没有测得必须改动的收益。开发机当时直连更快，但用户另一HK机房路由未经访问验证，不能称已是地理最短或全球最低延迟。提供 --compare 是为了从实际客户端所在地取得证据，不自动更换用户已选择的入口。

没有承诺所有未来Codex特性或所有公共OpenAI API：固定CLI 0.162.1、订阅权限、HTTP/SSE与1MiB请求上限明确保留；原生Responses WebSocket、remote compact等与当前固定CLI自定义提供商的本地压缩并非同一协议路径。

## 0.1.6 灵活节点检测

`ping <WSS URL>` 和 `ping --server <WSS URL>` 临时指定检测节点，保留当前配置。`--compare` 支持与当前地址相同的 URL，也可结合 `--server` 明确指定两端。同地址结果说明两条独立连接的差异；不同地址报告配对请求差异。

比较模式分别显示两端连接建立耗时，在两条隧道鉴权后交替进行各 5 次目录探测，随后展示各自遥测。统计只包含配对请求，省去此前前置的 5 次单独探测。包含初始化目录读取时，两端合计 12 次目录请求；这些请求不发起模型生成。检测过程保留配置和 Token 文件，取消后清理两条连接。
