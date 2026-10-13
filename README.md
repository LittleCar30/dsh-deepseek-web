# dsh-deepseek-web

`dsh-deepseek-web` 是一个可独立安装的 dsh 桌面版插件。它把已登录的
`chat.deepseek.com` 网页版接入 dsh 的 LLM 通道，并提供可选的 Kimi / GLM 审核通道。
项目自身包含源码、构建配置、发布清单和诊断工具，不依赖任何 dsh 源码 checkout。

## 能做什么

- 注册 `deepseek-web` provider，把 dsh 的消息转换为网页端对话。
- 使用用户安装的真实 Edge 或 Chrome 窗口，默认用独立 `managed` profile；也支持 CDP `attach`。
- 保留人工点击发送的确认点（`sendMode: manual`），避免插件自动替用户提交网页请求。
- 将网页端正文、JSON 工具动作、频控和 token 用量转换回 dsh 格式；默认不展示思考过程。
- 在上下文过长时建立新的网页对话，并携带任务简报继续执行。
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

## 安装

### npm 安装

在 dsh 桌面版使用的 Node/npm 环境中执行：

```bash
npm install dsh-deepseek-web
```

### tgz 安装

从 Release 下载 `dsh-deepseek-web-*.tgz` 后，在 dsh 的插件或 profile 目录执行：

```bash
npm install /path/to/dsh-deepseek-web-0.2.11.tgz
```

Windows PowerShell 示例：

```powershell
npm install .\dsh-deepseek-web-0.2.11.tgz
```

### Desktop profile 安装

如果桌面版使用 profile manifest，把包加入该 profile 的依赖，并将包名加入 bundles：

```json
{
  "dependencies": {
    "dsh-deepseek-web": "^0.2.11"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-deepseek-web"]
    }
  }
}
```

使用本地 tgz 时，将依赖值改成 `file:` 绝对路径。升级本地 tgz 时请递增版本号，
让包管理器重新计算完整性哈希。

### 手动 patch

包内的 `dsh.patch.yml` 会把 `lib/index.js` 挂载为 host 插件，把 `lib/client.js`
注册为 web client。也可以显式指定 patch：

```bash
dsh web --patch node_modules/dsh-deepseek-web/dsh.patch.yml
```

`cordis.yml` 是源码开发时的最小 patch 示例；发布安装优先使用包自带的
`dsh.patch.yml`，它的相对路径始终以包目录为基准。

## 首次使用

默认配置是 `browser: managed`。第一次使用时，插件会直接启动一个独立的真实 Edge 窗口，
并在该窗口中打开 DeepSeek；登录状态保存在插件专用 profile 中：

启动桌面版并第一次选择该模型时，插件会自动打开这个窗口；完成登录后即可继续任务。

如果选择 `browser: attach`，才需要先启动带 CDP 端口的外部浏览器：

```bash
node node_modules/dsh-deepseek-web/tools/browser-keeper.mjs \
  --profile "%LOCALAPPDATA%\DshDeepSeekWeb\edge-profile" \
  --port 9333 --url https://chat.deepseek.com
```

启动桌面版后，在插件列表中确认 `llm-deepseek-web` 已注册，模型选择
`deepseek-web`。第一次发送时，插件会把消息填入网页输入框并聚焦浏览器；
默认需要用户在网页中点击“发送”。

### dsh 新对话与网页窗口

dsh 创建新对话时，插件会在已经打开的 DeepSeek 浏览器窗口和当前标签页中点击网页的
“新对话”入口。它不会为每个 dsh 对话重新启动浏览器，也不会额外打开新的网页标签；
上下文过长需要轮换时同样复用当前页面。只有首次使用、页面被用户关闭或浏览器进程失效时，
插件才会重新建立页面连接。

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
node node_modules/dsh-deepseek-web/tools/open-login-kimi.mjs
node node_modules/dsh-deepseek-web/tools/inspect-kimi.mjs
node node_modules/dsh-deepseek-web/tools/open-login-glm.mjs
node node_modules/dsh-deepseek-web/tools/glm-status.mjs --turn
```

审核证据会优先读取工具实际写入的文件，并在达到 `maxEvidenceChars` 时标注截断。

## 项目结构

```text
src/                 host/client TypeScript 源码
lib/                 npm 发布的 host/client 构建产物
tools/               登录、CDP keeper、协议检查和解析自测
dsh.patch.yml        发布包的桌面版 bundle patch
cordis.yml           源码开发时的最小 patch
INSTALL.md           安装速查
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
审核证据、频控、用量、handoff、思考展示与长委托回复逻辑。需要真实网页时，再使用 `tools/` 下的登录和检查脚本。

## 卸载

在安装插件的目录执行：

```bash
npm uninstall dsh-deepseek-web
```

同时从 profile bundles 或 `--patch` 参数中移除插件条目。若不再保留登录态和运行数据，
可删除 `%LOCALAPPDATA%\DshDeepSeekWeb\`。
