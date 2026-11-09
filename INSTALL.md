# 中文安装速查

本项目 GitHub 发行版：**0.2.17**，已验证 dsh 桌面版 0.2.2-rc.1。npm 目前仍为 0.2.14；0.2.15 及后续版本尚未上传 npm，等待维护者恢复双重验证。

## 新用户：在桌面版输入发行包链接安装

1. dsh 左侧栏点击 **插件 → 添加插件**。
2. 粘贴下面的 GitHub 安装包链接，点击 **安装**。
3. 安装完成后点击 **立即启用**，然后重启 dsh。
4. 选择 `deepseek-web`，在插件自动打开的 Edge 窗口登录 DeepSeek。

```text
https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.2.17/dsh-deepseek-web-littlecar30-0.2.17.tgz
```

无需安装 Node.js、克隆源码或手改配置文件。安装包内已带 host/client 编译产物。
默认模式需要在网页手动点发送；自动模式选择 `deepseek-web-auto`。

## 已有用户：卸载旧包，再安装新版

插件管理界面目前不支持自动更新。先记下自定义配置，在插件页卸载旧版，
再按上面步骤安装并重启。0.2.12 及以前包名为 `dsh-deepseek-web`，
0.2.13 起包名为 `dsh-deepseek-web-littlecar30`，不要同时启用两者。
卸载保留 `%LOCALAPPDATA%\DshDeepSeekWeb\` 中的浏览器登录态和运行数据；不用删除状态文件。
安装后在新插件详情的 `llm-deepseek-web` 行点击 **配置**，检查自定义设置。
0.2.15 的发送方式可选「跟随模型入口 / 半自动 / 全自动」，保存后下一轮生效；浏览器连接设置需重启。
若旧白名单挡住新增工具，在「工具范围」点击 **使用宿主全部工具** 并保存；dsh 的权限与审批仍生效。

## 其他安装入口与常见问题

- **GitHub 链接**：使用上面的 0.2.17 安装包链接。
- **本地安装包**：从 [Release](https://github.com/LittleCar30/dsh-deepseek-web/releases/latest) 下载 `.tgz`，
  在「添加插件」输入框粘贴完整绝对路径，例如 `C:\Users\你的用户名\Downloads\dsh-deepseek-web-littlecar30-0.2.17.tgz`。
- **npm**：[发行页](https://www.npmjs.com/package/dsh-deepseek-web-littlecar30)，当前公开最新版为 0.2.14；安装新版请使用 GitHub 或本地安装包。
- **不能安装 `dsh-deepseek-web`**：npm 上这个名字属于另一位作者，不是本项目；务必使用完整新名字或本项目 Release 链接。
- **下载失败**：安装界面展开「查看安装详情」查看原因。npm 镜像可帮助下载依赖，不能代替访问 GitHub。
- **没有「添加插件」入口**：更新 dsh 桌面版；本流程已对照 0.2.2-rc.1 的插件管理说明。手工 profile/CLI 见 [README](README.md#命令行--手动-profile进阶)。
- **已安装但没生效**：确认点击过「立即启用」、没有同时启用旧包，并重启 dsh；插件页检查 `llm-deepseek-web` 的运行状态。
- **本地配置页提示「当前连接不允许保存设置」**：0.2.15 / 0.2.16 对新版 DSH 表单存在只读误判，请升级 0.2.17 并重启；不需要改账号、登录或管理员权限。
- **新建会话报 `tool-subagent-list-agents … /list-agents: never started`**：新版 DSH 已将 `list_agents` 合并到 `@deepseek-ai/dsh-tool-subagent-control` 主入口。备份 profile 的 `cordis.patch.yml`，在报错预设的 `delegation.config` 中删除 `name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'` 所在的旧插件行，保留主入口，再重启 DSH。只删除这条旧插件声明，不要清空整个预设。详见[验证记录](docs/COMPATIBILITY-2026-11-09.md#新建会话失败的配置修复)。

## 首次登录与模型选择

默认模式是 `browser: managed`。启动桌面版并第一次使用模型时，插件会直接打开
独立的真实 Edge 窗口；在该窗口登录 DeepSeek 即可。登录态和状态文件位于
`%LOCALAPPDATA%\DshDeepSeekWeb\`，后续会复用同一个 profile。

只有选择 `browser: attach` 时，才需要手动启动 CDP 浏览器：

```bash
node node_modules/dsh-deepseek-web-littlecar30/tools/browser-keeper.mjs --port 9333
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
更多恢复条件、限制与排查步骤见 [进阶文档](docs/ADVANCED.md#context-recovery)。

## 可选审核

在插件设置中打开 `review.enabled`，并选择 `deepseek-web`、`kimi` 或 `glm`。
Kimi / GLM 需要先运行对应的登录工具，并保持审核浏览器的 CDP 端口可用：

```bash
node node_modules/dsh-deepseek-web-littlecar30/tools/open-login-kimi.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/open-login-glm.mjs
```

## 验证安装

插件页应出现 **DeepSeek 网页版通道**，其 `llm-deepseek-web` 行应启用，能打开中文配置页。
模型列表应出现 `deepseek-web` 与 `deepseek-web-auto`。先发送一句简单问候，
确认 Edge 中可以提交消息，dsh 收到最终正文；半自动模式需要你在网页点发送。

开发者离线测试需在源码目录执行 `npm run test:parsers`，普通安装用户无需运行。

## 卸载

桌面版 **插件 → 本插件详情 → 卸载**。登录态和运行数据默认保留。
手工 profile/CLI 安装者的卸载命令见 README。
