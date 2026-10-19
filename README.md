<div align="center">

<img src="docs/assets/readme-banner.svg" alt="DeepSeek 网页通道：真实浏览器、半自动或全自动发送、可选交付审核。右侧为流程示意。" width="100%">

# DeepSeek 网页通道

**用你已登录的 DeepSeek 网页，接入 dsh 的任务与工具工作流。**

真实 Edge / Chrome · 半自动与全自动 · 默认只展示结果 · 可选 Kimi / GLM 审核

[![npm](https://img.shields.io/npm/v/dsh-deepseek-web-littlecar30?style=flat-square&color=168c92&label=npm)](https://www.npmjs.com/package/dsh-deepseek-web-littlecar30) [![Release](https://img.shields.io/github/v/release/LittleCar30/dsh-deepseek-web?style=flat-square&color=477cce&label=release)](https://github.com/LittleCar30/dsh-deepseek-web/releases/latest) [![License](https://img.shields.io/badge/license-MIT-69798b?style=flat-square)](LICENSE) [![DSH](https://img.shields.io/badge/DSH-community_plugin-6b74b4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

[快速安装](#quick-start) · [功能一览](#features) · [工作原理](#how-it-works) · [常见问题](#faq) · [更新记录](CHANGELOG.md) · [赞助支持](#sponsor)

</div>

<a id="quick-start"></a>
## 从安装到第一条消息

准备好 **dsh 桌面版 0.2+、Edge 或 Chrome，以及 DeepSeek 网页账号**。
普通桌面版用户无需安装 Node.js、下载源码或手改配置文件。

1. 打开 dsh 左侧栏 **插件 → 添加插件**。
2. 粘贴下面包名，安装源选择 **npm 官方源**，点击 **安装**。
3. 安装后点击 **立即启用**，然后重启 dsh。
4. 选择 `deepseek-web`，在自动打开的浏览器窗口登录 DeepSeek；网页填入消息后，点击发送。

```text
dsh-deepseek-web-littlecar30
```

当前正式版为 **0.2.14**。需要固定版本时，填 `dsh-deepseek-web-littlecar30@0.2.14`。
希望消息填入后自动发送，可改选 `deepseek-web-auto`。

> [!IMPORTANT]
> 本项目的 npm 包名是 **`dsh-deepseek-web-littlecar30`**。
> npm 的 `dsh-deepseek-web` 属于另一位作者，不是本仓库的发行包。
> 从本项目旧版升级时，先记下自定义设置、卸载旧包，再安装新版并重启。
> 不要同时启用新旧包；正常卸载保留浏览器登录态和运行数据。

<details>
<summary><b>其他安装方式：GitHub 链接 / 本地安装包</b></summary>

在同一个「添加插件」输入框粘贴发行包链接，也可以安装：

```text
https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.2.14/dsh-deepseek-web-littlecar30-0.2.14.tgz
```

或从 [Release](https://github.com/LittleCar30/dsh-deepseek-web/releases/latest) 下载 `.tgz`，粘贴文件的完整绝对路径，例如：

```text
C:\Users\你的用户名\Downloads\dsh-deepseek-web-littlecar30-0.2.14.tgz
```

发行包已包含 host/client 编译产物。安装依赖仍需要网络；镜像尚未同步时选择 npm 官方源。
切换 npm 镜像不能代替 GitHub 下载。

</details>

完整中文步骤、升级和卸载见 **[安装速查](INSTALL.md)**。

<a id="features"></a>
## 按你的工作方式使用

| 能力 | 你可以怎么用 |
| --- | --- |
| 🌐 **真实网页通道** | 插件启动独立 Edge / Chrome 窗口，复用其中的网页登录态；无需 API Key。 |
| 🎛 **两种发送方式** | 半自动模式先查看填入的内容再点击发送；全自动模式填入后自动回车。 |
| 📝 **结果直接呈现** | 默认展示最终正文或工具调用；网页委托正文完整返回，不再受旧版 6000 字符裁剪影响。 |
| 🧵 **长任务接续** | 同步任务上下文；宿主压缩后，利用检查点与近期消息建立接续对话。 |
| 🔎 **可选交付审核** | 使用 DeepSeek 同对话自审，或独立 Kimi / GLM 网页通道复核交付。 |
| ⚙️ **中文配置页** | 在插件详情中修改思考展示、审核、工具白名单、频控等设置。 |

### 选哪种模式？

| 模型入口 | 发送方式 | 适合的使用习惯 |
| --- | --- | --- |
| `deepseek-web` | 填入后由你点击网页发送 | 希望逐轮检查输入，再继续执行。 |
| `deepseek-web-auto` | 填入后自动回车发送 | 已确认任务和配置，希望连续运行。 |

这是**发送方式的区别**，不是两个不同的大模型。思考与联网开关由网页自身管理。
模式不会改变 dsh 对本地工具的权限与审批设置。

### 在哪里调整设置？

**插件 → DeepSeek 网页版通道 → `llm-deepseek-web` → 配置**。

- **只看结果**：关闭「显示网页思考过程」，即 `liveThinking: false`，这也是默认值。
- **选择浏览器**：`channel: msedge` 使用 Edge；`channel: chrome` 使用 Chrome。
- **开启审核**：打开 `review.enabled`，选择 `deepseek-web`、`kimi` 或 `glm`。

审核默认关闭。DeepSeek 自审不需要额外浏览器；Kimi / GLM 需要先在对应独立窗口登录。
[查看完整配置与审核准备](docs/ADVANCED.md#审核通道)。

<a id="how-it-works"></a>
## 一条消息如何完成

```mermaid
flowchart LR
    A["dsh：任务与工具结果"] --> B["插件：整理上下文"]
    B --> C["真实 Edge / Chrome 网页"]
    C --> D["手动点击 / 自动回车发送"]
    D --> E["解析网页回复"]
    E --> F["dsh：正文或工具调用"]
    E -. "按需审核交付" .-> G["DeepSeek / Kimi / GLM"]
    G -. "反馈修正" .-> B
```

消息由 **DeepSeek 网页本身**发出；插件操作输入框与发送入口，并读取网页请求的响应。
登录态保存在插件专用浏览器 profile 中。网页布局、接口或账号状态变化都可能影响使用。

正常任务使用工作标签；dsh 的内部摘要与标题请求使用独立临时标签，完成、失败或取消后关闭。
半自动模式下，内部请求也需要点击发送；全自动模式会自动发送。

<a id="faq"></a>
## 常见问题

<details>
<summary><b>升级了，为什么还显示很多思考？</b></summary>

旧配置显式保存了 `liveThinking: true` 时，升级会保留它。进入配置页关闭「显示网页思考过程」即可。
这只影响 dsh 展示，不关闭 DeepSeek 网页思考模式，也不删除已有对话记录。

</details>

<details>
<summary><b>长正文还会被截断吗？</b></summary>

旧版对网页委托正文的 6000 字符裁剪已移除，最终正文和网页委托结果完整返回。
`maxToolResultChars` 仍限制本地工具结果送入网页模型的长度；这是工具输入的限制。

网页自身仍有生成和上下文上限。网页明确报告截断或中断时，插件会报错；站点没有报告原因时，
无法保证识别所有截断，也不能保证网页执行宿主的 `maxTokens`。

</details>

<details>
<summary><b>为什么出现英文交接摘要，或者任务突然变了？</b></summary>

dsh 的内部压缩请求可能要求生成英文交接摘要，它应作为后续任务上下文。
0.2.12 起，插件隔离这类辅助请求，并在压缩后恢复任务检查点；它不会把所有英文回复一律过滤。

升级并重启后继续原任务即可，无需删除状态文件。宿主历史已经缺少任务信息时，需重新说明任务。
[查看压缩接续的恢复条件与限制](docs/ADVANCED.md#context-recovery)。

</details>

<details>
<summary><b>可以直接把图片交给模型看吗？</b></summary>

当前插件把图片和文件附件转成文字标记，尚未实现实际上传。
仅附上图片，不代表网页模型已经看到图片内容。

</details>

<details>
<summary><b>安装失败，或者安装后没有模型？</b></summary>

先确认包名是 `dsh-deepseek-web-littlecar30`，安装源选择 npm 官方源。
安装后点击「立即启用」并重启；在插件页检查 `llm-deepseek-web` 是否启用、有没有错误。

如果下载 GitHub 链接失败，可改用 npm 包名安装。
[更多安装排查](INSTALL.md#其他安装入口与常见问题)。

</details>

<details>
<summary><b>登录态在哪里？卸载会清掉吗？</b></summary>

Windows 默认数据目录是 `%LOCALAPPDATA%\DshDeepSeekWeb\`，可在配置中指定浏览器 profile。
正常卸载保留这些数据。需要彻底清除时，在停用插件并关闭对应浏览器后，手动删除不再需要的数据。

</details>

本项目是社区插件，与 DeepSeek 官方无隶属关系。通过真实浏览器操作不代表无法被检测；
网页可用性、账号状态和网络环境均由对应服务决定。

<a id="命令行--手动-profile进阶"></a>
## 配置与进阶使用

| 文档 | 内容 |
| --- | --- |
| [INSTALL.md](INSTALL.md) | 中文安装、升级、首次登录与卸载。 |
| [配置与进阶使用](docs/ADVANCED.md) | CLI / profile、CDP attach、完整配置表、审核与压缩接续。 |
| [CHANGELOG.md](CHANGELOG.md) | 版本修复与包名迁移记录。 |
| [RELEASING.md](RELEASING.md) | 维护者的打包、认证、发布与验证流程。 |

## 开发与验证

源码开发需要 **Node.js 22+**，并满足宿主提供的 `@deepseek-ai/*` 与 React peer 依赖。

```bash
npm install
npm run build
npm run test:parsers
npm pack
```

构建生成 `lib/index.js` 与 `lib/client.js`，发行包无需用户编译。
11 项离线检查覆盖 SSE 解析、工具动作、频控、用量、长委托回复、辅助调用隔离与压缩接续。
浏览器隔离使用模拟页面验证；网页登录、站点结构及发送行为需要真实网页另行验证。

<details>
<summary><b>项目结构</b></summary>

```text
src/                 host/client TypeScript 源码
lib/                 发行包构建产物
tools/               登录、诊断与离线检查
docs/                进阶文档与首页插图
dsh.patch.yml        桌面版 bundle patch
INSTALL.md           中文安装速查
CHANGELOG.md         版本更新记录
RELEASING.md         维护者发布流程
```

</details>

## 反馈问题

通过 [GitHub Issues](https://github.com/LittleCar30/dsh-deepseek-web/issues) 提供插件与 dsh 版本、
使用的发送模式、复现步骤，以及相关错误或最后一段回复。日志中的登录凭证请先隐藏。

<a id="sponsor"></a>
## 赞助支持

**项目免费开源，赞助完全自愿，不影响任何功能的使用。**

如果这个插件帮你省下了时间，欢迎通过微信扫码支持作者，鼓励后续维护与功能改进。
金额随心，感谢每一份支持！点亮 Star、分享项目和反馈问题，同样是很好的支持方式。

<p align="center">
  <a href="docs/assets/wechat-sponsor.jpg">
    <img src="docs/assets/wechat-sponsor.jpg" alt="微信扫码赞助支持作者小汽车" width="320">
  </a>
</p>
<p align="center">使用微信扫一扫；手机访问时可点击图片查看原图，保存后在微信中识别二维码。</p>

项目按 [MIT License](LICENSE) 开源。
