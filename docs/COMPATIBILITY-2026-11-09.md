# DSH 与 DeepSeek 网页兼容性验证

验证日期：2026-11-09。插件版本：0.2.15 / 0.2.16 / 0.2.17。核心兼容性测试针对 0.2.15；0.2.16 补充详情页与本机旧预设修复验证；0.2.17 修复客户端配置表单的只读误判。

## 验证目标

官方 Windows x64 nightly 更新源 `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml` 返回 0.2.2-rc.1，发布时间为 2026-11-04T09:31:49.677Z。本机安装包同为 0.2.2-rc.1，提交 `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`，内置 Cordis 4.1.0 / Schemastery 3.19.0。

从实际 `app.asar` 提取配置、插件管理、工具和 LLM 包进行接口验证，没有替换桌面程序。原包整体 REA 分析遇到一个无关 LibreOffice 可执行文件的 ASAR 声明摘要与伴随文件摘要不一致；配置分析改为针对提取的实际 `dsh-settings` 包，未将该校验差异误判为插件问题。

## 已修复的问题

| 问题 | 修复后的行为 |
| --- | --- |
| 浏览器类型、连接模式、profile 字段没有 volatile 标记，宿主拒绝写入 | 页面所有字段均被宿主配置服务投影，可持久化；连接设置重启后生效 |
| 保存整份旧草稿可能覆盖同期修改 | 仅提交改过的字段，使用首次编辑时的 revision；冲突拒绝保存 |
| 数字清空提交空值、工具名单无法自然换行 | 编辑时保留原始输入，保存时验证和归一化；失败保留草稿 |
| 页面修改 model 未控制真实发送 | 新 sendMode 设置控制普通、工具后续和内部辅助请求，下轮生效 |
| 新网页先发送 SET，再发送省略操作符的 fragments 完整快照 | 正确继承 SET，重建正文与思考；支持 APPEND、显式索引和 BATCH |
| 固定旧工具白名单阻挡新版工具 | 新配置默认不限制宿主工具；旧配置可一键清空，保留用户显式限制 |
| 精简目录丢失可选及嵌套参数、多结果错配 | 保留参数结构，按调用 ID 关联工具结果，目录改变立即刷新 |

发送偏好：`model` 跟随 dsh 当前模型入口；`manual` 强制人工发送；`auto` 强制自动发送。旧 `approved` 值保持跟随入口语义，不代表权限审批。已有显式 `manual` 设置会强制人工发送；若希望继续按两个模型入口区分，请在新页面选择「跟随模型入口」。

## 验证结果与边界

- `npm test`：全部离线回归通过，含解析、DSML、参数修复、工具结果关联、频控、压缩接续、审核隔离、发送设置和配置草稿检查。
- `npm run build`：host / client 构建通过。
- 实际新版 `SettingsForms`：schema 投影、字段写入、YAML 保存/重读、运行中 volatile 引用更新、revision 冲突拒绝、非法数字拒绝、继承值恢复均通过。配置编辑器及文件 I/O 使用隔离测试实现，没有修改用户 profile。
- 实际新版 `dsh-tools` / `dsh-llm`：工具 Schema 编译/参数验证、BlockAssembler 接收插件流、宿主消息构造及两轮工具结果回传通过。
- 浏览器配置页：真实 React + Edge 点击测试通过，覆盖选择卡、开关、列表清空、嵌套字段保存、失败保留草稿、冲突拒绝、只读、中文路径。宽屏、390px 窄屏和深浅色截图检查通过。表单由测试壳提供，未声称在正在运行的 DSH 窗口逐项点击。
- 真实 DeepSeek 网页：在用户登录的专用 Edge 中创建独立测试标签。首轮解析真实 `read` 调用，仅读取临时 fixture；工具消息回传后，第二轮最终正文匹配文件中的随机标记。两轮 HTTP 200，累计用量 667 → 912。
- 真实 DeepSeek 自审：另一次测试完成 `read → 临时文件结果 → 最终正文 → 自审`，三轮 HTTP 200，审核通过且记录一次审核，累计用量 663 → 914 → 1184。测试标签及连接已清理。

上述网页测试使用实际通道、适配器及新版宿主的消息/流接口；临时读取工具在测试脚本内受路径限制执行，没有调用运行中 DSH 的工具执行器或权限弹窗。不能据此保证所有 DSH/MCP 工具都能执行。Kimi / GLM 本轮只有合成解析测试，未重新登录实测。人工发送的等待分支和发送策略有回归覆盖，本轮在线测试使用全自动模式。网页图片/附件仍未实现真实上传。

本地原始测试证据在 `.runtime/compat-20261109/`，包括两次 `live-*/report.json`、测试 SSE 和 `ui/` 截图；不随发行包包含登录数据。

REA 配置包分析证据：`ev_3d839f5579b07534cd915ac1c12b232a0d9a8ad43b0f28f1b9efeff37d75a4ca`，只支持静态结论。登录后页面观察证据：`ev_b7315baa694198ccb012563ad7375d90148ea1ece1655528995e4acc93fcc083`；真实生成行为以本地测试报告为准。

## 新建会话失败的配置修复

用户遇到 `agent-preset/invalid: tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started`。实际 DSH 0.2.2-rc.1 包的 `exports` 已不提供 `./list-agents`，主入口现在一起注册 `list_agents`、`send_message`、`interrupt_agent`。本机 `preset-standard → delegation` 同时保留主入口和旧子入口，导致加载器导入失败，预设审计随后拒绝创建会话。

修复前已备份本机 `cordis.patch.yml`，仅删除旧入口的两行声明，共 113 字节。保留主入口、所有个人预设及其他配置，未改模型路由或工具权限。结构比较确认其他配置一致；用户随后确认**新建会话成功**。备份仅保存在本机，不上传含个人配置的文件。

`tools/host-subagent-compat-check.mjs` 使用安装包提取的真实 Cordis 加载器：复现 `ERR_PACKAGE_PATH_NOT_EXPORTED` 和无 fiber 的旧行；删除该行后主入口加载成功，三种工具均注册，实际 `list_agents` handler 通过服务替身执行。该脚本不创建桌面会话、不启动真实子代理；桌面恢复结论来自用户确认。此问题发生在宿主预设加载阶段，插件不自动修改其他用户的宿主预设。

REA 静态证据：`ev_e98f98b53d808df5d21b36d185630ea3bb90ba07761eecaeb85669416e384d9d`，目标为实际 `dsh-tool-subagent-control` 包；动态加载结论来自上述独立验证脚本。

## 0.2.16 插件详情

实际宿主 `dsh-plugin-detail` 优先读取 locale 的 `meta.detail`。新增 `locale/zh.json`、`en.json` 与短 Markdown 说明，保留完整 README。直接调用实际宿主解析器验证：`zh-CN` / `zh-TW` 选择中文详情，`en` / `en-GB` 选择英文，`fr-FR` 回退英文；无 locale 时仍回退 README。发行清单包含短详情且排除用户未提交的博客草稿。

## 0.2.17 配置页只读误判

用户在本地桌面端遇到「当前连接不允许保存设置。请在拥有此插件的 dsh 桌面端编辑」。这条提示来自插件页面额外要求 `form.state.mode === 'host'`。实际 DSH 0.2.2-rc.1 的客户端 ConfigForms 快照为 `status / value / base / user / revision / writable`，没有 `mode`；即使宿主允许写入，页面也会禁用所有控件。

0.2.17 按 `status === 'ready' && writable === true` 判断能否编辑，读取中、不可用与只读分别提示。此前 UI 测试壳人为补入了 `mode: host`，因此没覆盖此缺陷；本次改用实际客户端控制器生成的快照结构，没有添加该字段。

扩展 `tools/settings-host-check.mjs`，执行提取安装包中的 `dsh-client-ui-settings/lib/client.js` 与实际宿主 SettingsForms：证明 ready+writable 快照不含 mode，客户端修改发送方式后能写入隔离 YAML、更新宿主 volatile 引用；陈旧 revision、非法数字、只读写入均拒绝。客户端 snapshot 存储、Remote 传输与配置编辑器使用隔离替身，未在用户设置中执行测试写入。真实 React / Edge 页面采用该控制器输出的快照结构，选择、开关、保存、错误保留草稿、冲突和只读检查通过；读取中与不可用状态也验证通过。未声称自动点击正在运行的 DSH 桌面窗口。

实际客户端静态分析证据：`ev_878fa2340165365cd739e320af59e93f4e8abe7b52808d84b3afa155caa48657`。

## 安装 0.2.17

在桌面版「插件 → 添加插件」中粘贴 `https://github.com/LittleCar30/dsh-deepseek-web/releases/download/v0.2.17/dsh-deepseek-web-littlecar30-0.2.17.tgz`，安装后启用并重启。也可从 [GitHub Release](https://github.com/LittleCar30/dsh-deepseek-web/releases/tag/v0.2.17) 下载 `.tgz`，通过本地完整路径安装。npm 公开最新版仍为 0.2.14；后续新版发布等待维护者恢复双重验证。已安装旧版时，按宿主提供的卸载/重装流程更换；先记下自定义设置，保留浏览器登录数据。

进入「DeepSeek 网页版通道 → llm-deepseek-web → 配置」，按需选择发送方式。如需使用新增工具，点击「使用宿主全部工具」并保存；已有白名单不会被静默覆盖。

开发者可复跑：

```powershell
npm test
npm run build
node tools/settings-host-check.mjs <提取的实际dsh目录>
node tools/host-subagent-compat-check.mjs <提取的实际dsh目录>
npx tsx tools/host-tool-compat-check.ts <实际dsh/node_modules/@deepseek-ai目录>
# 下列命令会在已登录专用浏览器中真实发送测试消息：
npx tsx tools/live-browser-check.ts <实际dsh/node_modules/@deepseek-ai目录> 9333
npx tsx tools/live-browser-check.ts <实际dsh/node_modules/@deepseek-ai目录> 9333 --self-review
```
