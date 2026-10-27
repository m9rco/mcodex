# 独立运行包 0.3.4：离线健康检查的首次执行预算

2026-10-27。npm 启动器仍为 0.3.0，官方 Codex 0.163.0、native 0.4.3 和内部平台包 0.1.4 保持不变，保留 0.3.3 的启动优化与模型目录缓存。

公开安装验收复现了 macOS 新解压 Codex 首次执行超过内部 5 秒版本探针：更新的本地健康检查在约 5.1 秒失败，旧运行包正确保留。同一二进制随后在 124 毫秒内返回正常版本。外层 30 秒更新检查、签名和文件完整性均不是该次失败原因。

只把 `doctor --local` 中 Codex 与 native 的版本探针预算各设为 10 秒。两个探针的合计预算为 20 秒，仍处于原启动器 30 秒总限时内；普通启动、login 和网络 doctor 保留原 5 秒版本探针。精确版本、签名、摘要、取消和错误退出判定不变，不自动重放命令，也不绕过健康检查。

两条 CLI 回归分别模拟有效 Codex/native 首次执行耗时 5.5 秒：修改前均在约 5 秒失败，修复后通过。164 项 Node 测试与语法检查全部通过。公开升级工作流另从 npm 原版 0.3.0 在三个平台的隔离环境中执行签名更新、激活和本地诊断。

```sh
mcodex update
mcodex runtime status
mcodex doctor
```

退出并重新启动 mcodex 后使用新版。期望 `Launcher 0.3.0; runtime 0.3.4; source: managed`，native 0.4.3、官方 Codex 0.163.0。

## 正式发行

[PR #6](https://github.com/m9rco/mcodex/pull/6) 合并为 `7c4e549fd689477595d5aab4f65238cd2c5285a7`。[发行前检查](https://github.com/m9rco/mcodex/actions/runs/40533003161) 的三个平台构建、实际解包与功能验收通过；Node 与双版本 Codex 检查也全部通过。

[正式发行流水线 40535065749](https://github.com/m9rco/mcodex/actions/runs/40535065749) 全部成功，[runtime-v0.3.4](https://github.com/m9rco/mcodex/releases/tag/runtime-v0.3.4) 于 2026-10-27 15:53 UTC 公开，签名稳定通道已更新。原 npm 启动器与历史发行资产保持不变。

本机候选使用原构建和解包验收脚本，不加日志 hook、验证覆盖或超时覆盖；默认构建约 19.9 秒、解包和健康检查约 4.8 秒通过。该本地候选未作为正式发行包。

曾复现 0.3.3 超时的同一台 macOS，使用未修改的公开 npm 0.3.0 启动器和全新的 HOME/config/runtime，首次公开升级到 0.3.4 成功，无需重试。`update --check` 约 3.9 秒、包含下载与验证的 `update` 约 53.8 秒、后续 `doctor --local` 约 2.2 秒，均退出 0。实际显示 runtime 0.3.4 / native 0.4.3 / package 0.1.4 / Codex 0.163.0，原签名、摘要和健康检查原样执行；npm 源文件与旧取证记录的摘要均未变化。这些耗时不是用户 Linux 出口的启动耗时。

[公开升级验收 40535587793](https://github.com/m9rco/mcodex/actions/runs/40535587793) 的 Linux x64、Linux ARM64、macOS ARM64 全部成功。三个平台均从真实 npm 0.3.0 的空运行包缓存执行第一次公开签名更新，再核验 managed 选择、精确 Codex/native 版本与包内摘要，未重试健康检查、手工选择运行包或使用本地候选替代发行包。
