# dsh-deepseek-web

`dsh-deepseek-web-littlecar30` 是本项目的发行包，可独立安装到 dsh 桌面版。它把已登录的
`chat.deepseek.com` 网页版接入 dsh 的 LLM 通道，并提供可选的 Kimi / GLM 审核通道。
项目自身包含源码、构建配置、发布清单和诊断工具，不依赖任何 dsh 源码 checkout。

## 能做什么

- 注册 `deepseek-web` provider，把 dsh 的消息转换为网页端对话。
- 使用用户安装的真实 Edge 或 Chrome 窗口，默认用独立 `managed` profile；也支持 CDP `attach`。
- 保留人工点击发送的确认点（`sendMode: manual`），避免插件自动替用户提交网页请求。
- 将网页端正文、JSON 工具动作、频控和 token 用量转换回 dsh 格式；默认不展示思考过程。
- 在上下文过长时建立新的网页对话，并携带任务简报继续执行。
- 将 dsh 内部摘要/标题请求放到独立临时页面，压缩后恢复正常任务上下文。
- 通过 dsh 的插件设置页修改配置；客户端侧提供配置页和对话视图空白自愈。
- 可选在同一 DeepSeek 对话中自审，或通过独立浏览器窗口使用 Kimi / GLM 审核。

## 运行要求

- dsh 桌面版 0.2 或更高版本，且宿主提供本包声明的 `@deepseek-ai/*` peer 依赖。
- Node.js 22 或更高版本（仅在使用命令行工具、从源码构建或安装 tgz 时需要）。
- Microsoft Edge 或 Google Chrome；默认使用 Edge。
- DeepSeek 网页账号。Kimi / GLM 审核只有在对应网站完成登录后才可用。

本插件只依赖宿主提供的 dsh 接口。`@deepseek-ai/cordis`、`dsh-llm`、`dsh-brand`
和 `schemastery` 保持为 peer dependency，以确保插件与桌面版使用同一份运行时模块。
`playwright-core` 是插件自己的运行依赖，会随 npm 包安装。

## 安装（推荐：直接在桌面版操作）

1. 打开 dsh 桌面版，在侧栏点击 **插件 → 添加插件**。
2. 复制下面整行链接，粘贴到安装输入框，点击 **安装**。
3. 安装完成后点击 **立即启用**，再重启 dsh，确保新版模块已加载。
4. 选择 `deepseek-web` 模型，在自动打开的 Edge 窗口登录 DeepSeek，即可开始使用。

```text
https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.2.13/dsh-deepseek-web-littlecar30-0.2.13.tgz
```

**不用下载源码、安装 Node.js、运行 npm 或修改 profile。**
[下载最新版安装包](https://github.com/LittleCar30/dsh-deepseek-web/releases/latest) · [详细安装与排查](INSTALL.md) · [更新记录](CHANGELOG.md)

默认模型需要在网页中手动点击发送；希望自动发送时，选择 `deepseek-web-auto`。
中文配置入口在插件详情中的 `llm-deepseek-web` 行 → **配置**。

### 升级旧版

桌面版目前没有插件自动更新：在插件页卸载本项目旧包，再按上面步骤安装新版并重启。
0.2.12 及以前的包名是 `dsh-deepseek-web`，0.2.13 起改为 `dsh-deepseek-web-littlecar30`；
**不要同时启用两个包**。正常卸载保留 `%LOCALAPPDATA%\DshDeepSeekWeb\` 中的登录态和会话数据，
无需重新下载浏览器或删除状态文件。卸载前记下自定义配置，安装后检查并恢复这些设置。

### 网络不通时

如果 GitHub 链接无法访问，可先从 [Release](https://github.com/LittleCar30/dsh-deepseek-web/releases/latest)
下载 `.tgz`，在同一个「添加插件」输入框粘贴文件的**完整绝对路径**，例如：

```text
C:\Users\你的用户名\Downloads\dsh-deepseek-web-littlecar30-0.2.13.tgz
```

压缩包已经包含编译产物，但安装依赖仍需要网络；安装界面可选择 npm 官方源或中国大陆镜像源。
切换 npm 镜像不能代替 GitHub 下载。

### npm 入口（发布后可用）

本项目使用的 npm 包名是 `dsh-deepseek-web-littlecar30`。完成 npm 发布后，桌面版「添加插件」也可以直接填：

```text
dsh-deepseek-web-littlecar30@0.2.13
```

刚发布的版本请优先选择 **npm 官方源**，镜像可能尚未同步。
**不要安装 npm 的 `dsh-deepseek-web`，它属于另一位作者，并非本仓库的发行包。**

### 命令行 / 手动 profile（进阶）

已配置 dsh CLI 时，可以用官方插件管理命令安装同一个包：

```bash
dsh plugin --profile desktop add https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.2.13/dsh-deepseek-web-littlecar30-0.2.13.tgz
```

仅在需要手工管理 profile 时，把以下字段合并到现有清单，保留原有依赖和 bundles：

```json
{
  "dependencies": {
    "dsh-deepseek-web-littlecar30": "https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.2.13/dsh-deepseek-web-littlecar30-0.2.13.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-deepseek-web-littlecar30"]
    }
  }
}
```

之后在该 profile 目录执行宿主使用的包管理器安装命令，再重启。
本地文件使用 `file:` 绝对路径。包内的 `dsh.bundle.patch` 会自动加载 host/client。
手动 patch 启动和源码开发可用 `dsh web --patch node_modules/dsh-deepseek-web-littlecar30/dsh.patch.yml`；
普通桌面版安装不需要这一步。

## 首次使用

默认配置是 `browser: managed`。第一次使用时，插件会直接启动一个独立的真实 Edge 窗口，
并在该窗口中打开 DeepSeek；登录状态保存在插件专用 profile 中：

启动桌面版并第一次选择该模型时，插件会自动打开这个窗口；完成登录后即可继续任务。

如果选择 `browser: attach`，才需要先启动带 CDP 端口的外部浏览器：

```bash
node node_modules/dsh-deepseek-web-littlecar30/tools/browser-keeper.mjs \
  --profile "%LOCALAPPDATA%\DshDeepSeekWeb\edge-profile" \
  --port 9333 --url https://chat.deepseek.com
```

启动桌面版后，在插件列表中确认 `llm-deepseek-web` 已注册，模型选择
`deepseek-web`。第一次发送时，插件会把消息填入网页输入框并聚焦浏览器；
默认需要用户在网页中点击“发送”。

### dsh 新对话与网页窗口

dsh 创建新对话时，插件会在已经打开的 DeepSeek 浏览器窗口和当前标签页中点击网页的
“新对话”入口。普通任务复用当前工作标签，上下文过长需要轮换时同样复用当前页面。
从 0.2.12 起，dsh 内部摘要和标题生成会临时打开独立标签，共享登录态，结束、失败或取消后关闭；
不会向工作标签发送摘要指令。切换已有 dsh 会话或重启后首次使用时，会根据宿主历史重建上下文。

### 浏览器启动方式与网页可见特征

`managed` 模式直接启动系统已安装的 Edge/Chrome 可执行文件，再通过本地 CDP
连接；它不再使用 Playwright 的 `launchPersistentContext` 启动器，也不设置自定义
User-Agent 或额外 HTTP 请求头。网页看到的 UA、Client Hints、Cookie 和登录态来自
真实浏览器及插件专用 profile。

仍然需要说明：浏览器启用了本地远程调试端口，且页面操作由自动化协议驱动，网站不能被
保证为“绝对不可检测”。新实现去掉了旧的 `--disable-blink-features=AutomationControlled`
启动参数，行为更接近普通可见浏览器，但网络环境、账号行为、操作节奏和站点自身检测仍
可能影响风控结果。

## 配置

配置入口通常是桌面版的“插件”页面 → `dsh-deepseek-web` →
`llm-deepseek-web` → “配置”。也可以在 patch 的 `config` 中写入同样的字段。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `url` | `https://chat.deepseek.com` | DeepSeek 网页地址 |
| `browser` | `managed` | `managed` 启动独立浏览器，`attach` 连接外部 CDP |
| `channel` | `msedge` | managed 模式使用 `msedge` 或 `chrome` |
| `debugPort` | `9333` | attach 模式端口；managed 模式的首选端口，冲突时自动选择空闲端口 |
| `sendMode` | `manual` | 人工点击发送；`approved` 预留给宿主审批流 |
| `model` | `deepseek-web` | 网页模型开关校准目标 |
| `liveThinking` | `false` | 是否展示网页真实思考；正文不混入思考块，不改变网页思考模式 |
| `maxToolResultChars` | `6000` | 工具结果送入网页模型的字符上限，按头尾截断；不截断最终正文或网页委托结果 |
| `streamIdleTimeoutMs` | `600000` | 网页流空闲超时 |
| `rateLimit.enabled` | `true` | 是否自动处理“发送过于频繁” |
| `rateLimit.maxRetries` | `5` | 单轮频控重试次数 |
| `toolAllowlist` | 常用文件/终端工具 | 暴露给网页模型的工具白名单 |
| `excludeToolNames` | `['web_search']` | 强制隐藏的工具名 |
| `review.enabled` | `false` | 是否启用交付审核 |
| `review.provider` | `kimi` | `deepseek-web`、`kimi` 或 `glm` |
| `review.debugPort` | `9334` | Kimi 审核浏览器 CDP 端口 |
| `review.glmDebugPort` | `9335` | GLM 审核浏览器 CDP 端口 |

完整字段和默认值见 [`src/config.ts`](src/config.ts)。配置文件中的 profile、状态和
校准数据默认保存在 `%LOCALAPPDATA%\DshDeepSeekWeb\`，不会写入插件安装目录。

### 只返回结果与长回复

从 0.2.11 起，`liveThinking` 默认关闭，dsh 只输出最终正文或工具调用。
如果旧配置显式保存了 `liveThinking: true`，升级后仍会展示思考，请在插件配置中
关闭“显示网页思考过程”，或在 patch 的 `config` 中设置 `liveThinking: false`。
此设置不会关闭 DeepSeek 网页自身的思考模式，也不会删除已有对话里的思考记录。

手动开启后，思考块仅展示网页真实思考，回答正文和工具调用 JSON 不再混入思考块。
网页委托（如 `web_search` / `web_fetch`）返回的正文会完整展示，不再因超过
6000 字符而丢失末尾结论。`maxToolResultChars` 仍用于限制送入网页模型的工具结果，
审核证据的长度限制也继续生效。网页自身的生成或上下文长度上限仍由站点决定。

## 审核通道

审核默认关闭。开启后，每轮交付会根据 `review.provider` 选择：

- `deepseek-web`：同一网页对话自审，不需要额外浏览器。
- `kimi`：使用端口 `9334` 的独立 Kimi 窗口，需要先登录。
- `glm`：使用端口 `9335` 的独立 GLM 窗口，需要先登录。

登录和协议检查工具都在 `tools/`：

```bash
node node_modules/dsh-deepseek-web-littlecar30/tools/open-login-kimi.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/inspect-kimi.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/open-login-glm.mjs
node node_modules/dsh-deepseek-web-littlecar30/tools/glm-status.mjs --turn
```

审核证据会优先读取工具实际写入的文件，并在达到 `maxEvidenceChars` 时标注截断。
内部摘要和标题请求不进入交付审核，也不会附加“审核通过”等文字。

## 0.2.12：上下文压缩与任务接续

dsh 的上下文压缩会发起 `purpose: compaction` 辅助调用。已核查的桌面版
0.2.0-rc.2 官方压缩模板要求使用英文生成交接摘要；这类摘要应供后续模型使用，
不能代替用户要求的中文文件、流程包或其他交付。先前插件将它当成普通任务，
可能覆盖当前任务、清空消息游标，并遗漏压缩后的宿主检查点。

0.2.12 对 `compaction` 和 `session-title` 使用独立的一次性处理流程：

- 在临时网页对话中按此次请求提供的历史范围生成正文，不读取工作标签的隐式历史。
- 不修改正常会话的任务目标、游标、审核状态、最近回复或 token 基线；辅助用量单独计入通道总计。
- 不解析为本地工具动作，不执行网页工具委托，不展示辅助思考，不进入交付审核。
- 保留宿主系统指令、插件上下文和 `compact-checkpoint`（含兼容的 `<compacted-summary>` 格式）。
  检查点变化或旧游标失效时，在工作标签建立新对话，回放摘要、近期助手/工具消息与真实用户任务。
- 首次读取旧状态时同步宿主历史，清除明确的官方压缩指令污染；原任务已被压缩移除时，依据检查点继续。
- 对明确的未完成交接回复尝试一次纠错，仍返回交接摘要则报错；用户明确要求总结、摘要或分析时不拦截。

升级后重启 dsh，继续原任务即可触发状态恢复，无需删除状态文件或已有交付文件。
若旧会话保存了错误摘要且缺少原任务，请重新说明需要完成的工作或开启新对话。
旧版已生成/写入的摘要或文件不会被自动改写，也不能保证从不完整的宿主历史恢复丢失事实。

半自动模型的辅助请求仍需在临时标签人工点击发送；`deepseek-web-auto` 自动发送。
请求串行执行以避免输入和回复混用。临时标签使用同一网站登录态，摘要语言仍由宿主指令决定；
插件不会把所有英文回复一律过滤。

网页明确报告输出上限时，辅助请求返回 `max-tokens`，由 dsh 拒绝不完整摘要；
正常任务报 `WEB_REPLY_TRUNCATED`，不作为完整交付提交。网页报告中断或传输失败时会报错。
网站未提供结束原因时，插件不能仅凭最后一个词准确判断是否截断，也无法保证网页严格执行
宿主的 `maxTokens` 参数。摘要历史超过网页上限时，可在 dsh 的 `dsh-compaction-basic` 中配置
独立的 `summarizationProvider` / `summarizationModel`，或缩小压缩范围。

故障排查可对照 dsh 会话日志中的 `compaction/start`、`compaction/summary`、`compaction/end`
与后续普通助手回复，并记录 dsh/插件版本和网页对应回复；不要只凭回复语言判断来源。

## 项目结构

```text
src/                 host/client TypeScript 源码
lib/                 npm 发布的 host/client 构建产物
tools/               登录、CDP keeper、协议检查和解析自测
dsh.patch.yml        发布包的桌面版 bundle patch
cordis.yml           源码开发时的最小 patch
INSTALL.md           中文安装速查
CHANGELOG.md         版本更新与包名迁移记录
package.json         npm、dsh bundle 和 client 元数据
```

## 从源码构建与测试

```bash
npm install
npm run build
npm run test:parsers
npm pack
```

`npm run build` 生成 `lib/index.js`（host ESM）和 `lib/client.js`（web client bundle）。
解析器自测不访问网络，覆盖 DeepSeek SSE、Kimi Connect-RPC / gzip、GLM SSE、工具动作、
审核证据、频控、用量、handoff、思考展示、长委托回复、辅助调用隔离、压缩接续、旧状态恢复、
取消清理与结束原因。浏览器隔离使用模拟页面验证；登录态、站点导航及发送行为仍需真实网页验证。
需要真实网页时，再使用 `tools/` 下的登录和检查脚本。

## 卸载

在桌面版 **插件** 页打开本插件详情，点击 **卸载**。使用 CLI 管理时执行：

```bash
dsh plugin --profile desktop remove dsh-deepseek-web-littlecar30
```

手工安装者还需从 profile bundles 或 `--patch` 参数中移除对应条目。
登录态和运行数据保留在 `%LOCALAPPDATA%\DshDeepSeekWeb\`；仅在不再需要时手动删除。
