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

真实官方引擎的隔离验收已证明两个本地子 agent 同时请求，并把两份完成结果交回主 agent。新增目录摘要与版本选择单元测试，发行流水线也从解压运行包执行该并行验收。三平台发行与公开安装结果将在完成后补充。
