# 独立运行包 0.3.2：订阅共享与本地并行 agent

2026-10-27。npm 启动器保持 0.3.0，官方 Codex 0.163.0、原生包 0.1.3 / 二进制 0.4.2 不变。

复现了用户报告的 `subscription_sharing_unsupported_capability` / `param=input`：v2 子 agent 请求产生 `agent_message`。官方模型目录也可选择 v2，所以只关闭 feature flag 无效。回归测试在生产修复前因两个 `agent_message` 输入失败。

新会话对确切受验收引擎使用官方模型目录的兼容副本，只把 v2 协作格式改为 v1，并关闭显式 v2。其他目录字段通过还原后的原始摘要校验，保留模型提示和能力。本地并行能力保留，不静默删除或改写历史、工具或加密内容。未知外部引擎不套用旧元数据。

已包含 v2 历史的旧会话不会自动迁移；反复 continue / resume 仍可能携带不支持的输入。升级后应退出旧会话并新建会话，交接必要进度。

```sh
mcodex update
mcodex runtime status
mcodex
```

状态应为 `Launcher 0.3.0; runtime 0.3.2; source: managed`。npm 主包无需发布。

真实官方引擎的隔离验收已证明两个本地子 agent 同时请求，并把两份完成结果交回主 agent。新增目录摘要、版本选择和发行版本约束单元测试，发行流水线也从解压运行包执行该并行验收。

## 公开发行

[PR #3](https://github.com/m9rco/mcodex/pull/3) 已合并为 `200af36c619f2fbc6babb4c6c4b88aede6ff46bd`。[PR 运行包检查 40498330047](https://github.com/m9rco/mcodex/actions/runs/40498330047)、[双引擎矩阵 40498330053](https://github.com/m9rco/mcodex/actions/runs/40498330053) 和 [142 项 Node 测试 40498329956](https://github.com/m9rco/mcodex/actions/runs/40498329956) 全部通过。两个实际官方引擎版本均通过并行子任务回传验收；本机解压后的 macOS 运行包也通过了 15 项目录与并行 agent 验收。

[发行流水线 40498922314](https://github.com/m9rco/mcodex/actions/runs/40498922314) 的 Linux x64、Linux ARM64、macOS ARM64 构建、测试、实际解压包目录与并行 agent 验收、签名和匿名公开校验均成功。[runtime-v0.3.2](https://github.com/m9rco/mcodex/releases/tag/runtime-v0.3.2) 已公开，稳定通道已推进至 0.3.2。npm 启动器仍为 0.3.0，没有执行 npm 发布。

公开安装验证使用已发布的 npm 0.3.0 启动器、隔离 HOME 与运行包缓存。首次下载后的本地健康检查失败，基线版本保留，失败原因尚未确定。后续诊断仅将原 doctor 子进程的输出从忽略改为采集，保留原超时与退出判定；同一签名归档通过原健康检查（5151ms，退出码 0）。过程中也遇到两次代理下载未收到响应，未绕过签名、摘要或健康检查。

随后在该隔离缓存中用原 CLI 回退到 npm 基线，再由未修改的 `mcodex update` 对已缓存归档执行默认检查并成功激活。`runtime status` 与 `doctor --local` 均显示 `Launcher 0.3.0; runtime 0.3.2; source: managed`，引擎和原生版本匹配。最后从实际安装的公开运行包导入业务代码，使用其中官方引擎运行两个真实并发子任务，两份完成结果均交回主 agent。该结果确认原启动器可加载并运行修复；首次干净安装的健康检查失败仍作为未定原因保留，不视为已修复。
