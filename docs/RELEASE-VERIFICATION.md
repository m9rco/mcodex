# npm 发行验证

发布回执或网页两步验证完成，并不代表版本已能公开安装。npm 会异步校验新版本；HTTP 409 也不能当作成功。公开 metadata、`latest` 标签与实际 tarball 下载全部一致后，才宣布发行完成。

保留已审核的四个 npm tarball，放入同一冻结目录。主包和三个平台包的版本从 tarball 内 `package/package.json` 读取，平台版本必须与主包的 `optionalDependencies` 对应。

先发布三个平台包，再运行平台可用性检查。**三个原生包的公开 metadata、标签与下载摘要全部通过之前，不发布主包。** 这避免主包已可安装、某个平台依赖仍在 npm 校验中的不完整发行。

```sh
node scripts/verify-published.mjs --directory /tmp/mcodex-release-v0.2.1 --platforms-only
```

`--platforms-only` 仍读取四个冻结包并检查主包的依赖版本契约，只核验三个平台包的公开可用性。此检查退出码为 0 后，再发布已审核的主包，随后运行完整发行检查：

```sh
node scripts/verify-published.mjs --directory /tmp/mcodex-release-v0.2.1
```

脚本匿名读取 npm，不读取 Token、npmrc 或登录凭据，不执行发布操作。它核对所选包的公开 metadata、`latest` 标签和 SHA-512 integrity，并下载逐一比较冻结 tarball 的摘要。默认最多等待 300 秒，每 5 秒重查；完整检查退出码 0 表示四个包全部通过。可用 `--timeout-seconds 600 --interval-seconds 10` 延长校验等待。

未公开、未更新标签或下载尚未可用时，脚本会等待到设定时限；metadata 或下载内容与冻结包不一致时立即失败。超时后应查看 npm 的版本生命周期状态及暂存列表，不要反复提交同一包，也不要覆盖已发布的 Git 标签、tarball 或校验清单。修复后再次运行只读验证即可。

[npm Registry API](https://api-docs.npmjs.com/) 提供版本生命周期状态查询；[npm 暂存发布文档](https://docs.npmjs.com/cli/v11/commands/npm-stage/) 说明暂存和正式发行共享版本唯一性约束。状态查询和暂存列表可能需要维护者鉴权，它们与本脚本的匿名公开下载验收分开进行。

## 发布认证与目录优先级

先核对 `npm prefix` 识别到的项目根。npm 会向上寻找项目；在没有 package.json 的目录运行时，本机主目录可能被识别为项目根，项目层 `.npmrc` 会覆盖用户层的凭据。仅在 SDK 的 user 层注入 Token，不能保证实际请求使用了该 Token。401 应先区分凭据有效性、配置来源与网络，不能直接认定 Token 已失效。

本次维护脚本的修复是把受保护输入获得的凭据设为最高优先级的**进程内 CLI 配置**（不传入系统命令行参数，不保存配置），并核对 SDK 的有效凭据与 flatOptions 都等于刚注入的值，再验证 `whoami`。仅用于本次内存配置的示意：

```js
npm.config.set('//registry.npmjs.org/:_authToken', tokenFromMemory, 'cli');
```

不要打印、提交或写入日志中的 Token，也不要为了发布覆盖用户现有 npmrc。采用 SDK 的脚本还需随 npm 版本验证接口行为。网页登录和每个包的发布两步验证是不同步骤；当前 npm 服务可能逐包要求验证。发生网络错误时先检查该精确版本的生命周期状态，再按同一冻结内容恢复；不能用反复提交、改 tarball 或挪动标签解决认证。
