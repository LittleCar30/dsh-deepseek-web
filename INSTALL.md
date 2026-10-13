# 安装速查

`dsh-deepseek-web` 是面向 dsh 桌面版 0.2+ 的独立插件。它通过真实浏览器驱动
`chat.deepseek.com`，并把网页回复转换为 dsh 的 `deepseek-web` provider。

## 1. 安装包

```bash
npm install dsh-deepseek-web
# 或
npm install /path/to/dsh-deepseek-web-0.2.12.tgz
```

建议把包安装在桌面版使用的 Node/npm 环境中，使 `@deepseek-ai/cordis`、
`@deepseek-ai/dsh-llm` 等 peer 依赖解析到桌面版自己的实例。

## 2. 加入 Desktop profile

在 profile manifest 的 `dependencies` 中加入包，并在 `dsh.profile.bundles` 中加入
`dsh-deepseek-web`。本地 tgz 使用 `file:` 绝对路径；升级本地 tgz 时递增版本号。

```json
{
  "dependencies": { "dsh-deepseek-web": "^0.2.12" },
  "dsh": { "profile": { "bundles": ["dsh-deepseek-web"] } }
}
```

也可以直接用 patch 启动：

```bash
dsh web --patch node_modules/dsh-deepseek-web/dsh.patch.yml
```

不要把 patch 路径写死到某个工作区；包内 patch 会以自身目录解析
`lib/index.js` 和 `lib/client.js`。

## 3. 启动浏览器并登录

默认模式是 `browser: managed`。启动桌面版并第一次使用模型时，插件会直接打开
独立的真实 Edge 窗口；在该窗口登录 DeepSeek 即可。登录态和状态文件位于
`%LOCALAPPDATA%\DshDeepSeekWeb\`，后续会复用同一个 profile。

只有选择 `browser: attach` 时，才需要手动启动 CDP 浏览器：

```bash
node node_modules/dsh-deepseek-web/tools/browser-keeper.mjs --port 9333
```

启动桌面版后，模型选择 `deepseek-web`；默认发送模式需要用户在网页中人工点击“发送”。

0.2.11 起默认只输出最终正文或工具调用。若旧配置开启了实时思考流，升级后请在
插件配置中关闭“显示网页思考过程”（`liveThinking: false`）。这只控制 dsh 展示，
不改变网页思考模式；网页委托正文不再受 6000 字符的工具输入上限影响。

0.2.12 修复内部英文交接摘要覆盖用户任务的问题。安装新版包后重启 dsh，继续原任务，
插件会同步宿主历史并清理旧版明确的摘要指令污染；不需要删除会话状态文件。
原任务已被宿主压缩移除时，按压缩检查点继续。若宿主历史缺少任务信息，请重新说明任务。

内部摘要/标题请求会打开临时标签，完成、失败或取消后关闭，工作标签保持原对话。
半自动模型仍需在临时标签点击发送；自动模型自动发送。内部请求不执行工具，也不参与交付审核。
压缩完成后，工作标签会建立接续对话，接收检查点与近期消息。
网页明确报告截断或中断时不会按正常完成提交；网站不报告原因时无法保证识别所有截断。
更多恢复条件、限制与排查步骤见 README 的“0.2.12：上下文压缩与任务接续”。

## 4. 可选审核

在插件设置中打开 `review.enabled`，并选择 `deepseek-web`、`kimi` 或 `glm`。
Kimi / GLM 需要先运行对应的登录工具，并保持审核浏览器的 CDP 端口可用：

```bash
node node_modules/dsh-deepseek-web/tools/open-login-kimi.mjs
node node_modules/dsh-deepseek-web/tools/open-login-glm.mjs
```

## 5. 验证安装

确认插件列表出现 `llm-deepseek-web`，并运行：

```bash
npm run test:parsers
```

该命令只做离线解析和协议自测；网页登录、CDP 和页面结构检查使用 `tools/` 下的
`inspect-page.mjs`、`inspect-kimi.mjs`、`glm-status.mjs`。

## 6. 卸载

```bash
npm uninstall dsh-deepseek-web
```

从 profile bundles 或启动参数移除插件后，可按需删除
`%LOCALAPPDATA%\DshDeepSeekWeb\`。
