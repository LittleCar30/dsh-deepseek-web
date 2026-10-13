# 维护者发布流程

本仓库的 npm 包名为 `dsh-deepseek-web-littlecar30`，GitHub 仓库为
`LittleCar30/dsh-deepseek-web`。npm 的 `dsh-deepseek-web` 属于其他作者，不能用于本项目发布。

## 发布前

1. 同步 `package.json` 与 `package-lock.json` 的版本，更新 README、INSTALL 和 CHANGELOG。
2. 包名变更时，同步 `tsdown.config.ts` 的客户端模块 ID，以及配置页的 `PACKAGE_NAME`；两者必须与 manifest 一致。
3. 执行 `npm run build`、`npm run test:parsers`、`npm pack --json`，检查压缩包包含 host/client、patch 和中文文档。
4. 只有源码变更与构建产物一致、离线检查通过后，才提交并推送；真实网页测试是否执行应写明。

## npm 认证与发布

始终显式指定 npm 官方源，避免本机镜像设置影响维护者认证和发布：

```bash
npm login --auth-type=web --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish ./dsh-deepseek-web-littlecar30-0.2.14.tgz --access public --tag latest --registry=https://registry.npmjs.org
```

登录应在保持运行的交互终端中完成；临时登录链接失效时重新发起登录。
登录成功不代表具备发布所需的双重验证。若服务器提示发布需要 2FA，在 npm 账号设置中启用，
然后重新发布，并在浏览器或本机终端完成第二步认证；不要在仓库、聊天或发布说明中保存认证凭证。

确认 npm 返回发布成功后，再查询公开注册表验证版本、仓库信息和安装包完整性：

```bash
npm view dsh-deepseek-web-littlecar30 version dist-tags repository dist.integrity --json --registry=https://registry.npmjs.org
```

之后将 README / INSTALL 的 npm 入口改为已发布状态。刚发布的版本优先使用官方源，镜像可能稍后同步。

## GitHub Release

推送代码后，以完整提交 SHA 创建版本 Release，并上传与 npm 发布相同的 `.tgz`；
用 `--notes-file` 读取中文发布说明。Release 中直接给出「插件 → 添加插件 → 粘贴链接 → 立即启用」步骤。

`gh release view` 核对版本、提交和资产；本地安装包 SHA256 应与 GitHub 资产 digest 一致。
不要把推送代码、创建 GitHub Release 和发布 npm 混称为一次已经完成的发布。
