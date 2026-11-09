# DeepSeek 网页通道

通过已登录的 Edge / Chrome 使用 DeepSeek 网页版，接入 dsh 的任务与本地工具，无需 API Key。

## 主要功能

- 半自动或全自动发送消息，默认只展示最终结果。
- 调用 dsh 提供的工具，遵循宿主权限与审批。
- 长任务上下文接续、频控后重试、窗口自动切换。
- 可选 DeepSeek 自审，或 Kimi / GLM 独立审核。

## 开始使用与配置

启用后重启 dsh，选择 `deepseek-web`，在自动打开的浏览器中登录。消息填入后手动点击发送；选择 `deepseek-web-auto` 可自动发送。

配置入口：**插件 → DeepSeek 网页版通道 → llm-deepseek-web → 配置**。

在配置页调整发送方式、浏览器、审核与工具范围，点击「保存设置」后生效；浏览器连接设置需重启 dsh。升级后若看不到新工具，点击「使用宿主全部工具」并保存。

## 使用提示

- 网页思考与联网开关由网页管理；Kimi / GLM 审核需要单独登录。
- 网页布局、接口或登录状态变化可能影响通道；图片和文件尚不会实际上传到网页。
- 卸载通常保留浏览器登录状态与运行数据。

[安装与完整说明](https://github.com/LittleCar30/dsh-deepseek-web#readme) · [反馈问题](https://github.com/LittleCar30/dsh-deepseek-web/issues)
