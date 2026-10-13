/**
 * dsh-deepseek-web-littlecar30 插件的浏览器半侧。
 *
 * dsh 0.2 的插件配置界面不由 Config schema 自动生成，而要求插件客户端半侧显式注册到
 * Plugin Manager 声明的 slot；本文件注册 `plugins.row.config`（配置页）并挂载对话视图
 * 空白自愈。0.1 时代的 `ctx.settingsScope` / `SettingsScope` / `settings.plugin.item`
 * 在 0.2 中已全部移除，那套卡片与输入区面板无法平移，已由本配置页取代。
 *
 * @module dsh-deepseek-web-littlecar30/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型-only：拉起 ctx.slots / ctx.sessions / ctx.uiConversation 的声明合并，
// 以及 plugins.row.config 的槽位契约。client bundle 纯度门禁禁止值导入。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DeepSeekWebConfigPage, ROW_CONFIG_KEY } from './config-page.tsx'
import { monitorConversationBlank } from './conversation-recovery.ts'

/** Services this client module needs from the page's client context. */
export const inject = ['slots', 'sessions', 'uiConversation']

/**
 * Register the plugin's configuration page and the conversation-view safeguard.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContext): void {
  // 配置页：侧栏「插件」页 → 组合包 dsh-deepseek-web-littlecar30 → 行 llm-deepseek-web 上多出「配置」入口
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: ROW_CONFIG_KEY,
  }, DeepSeekWebConfigPage))

  // 历史对话空白自愈（上游 Discussion #6091 的兜底，见 conversation-recovery.ts）
  monitorConversationBlank(ctx)
}
