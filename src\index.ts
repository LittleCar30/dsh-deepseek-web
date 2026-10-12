/**
 * dsh-deepseek-web 插件入口。
 *
 * dsh 0.2 的插件配置界面由客户端半侧注册 `plugins.row.config` 槽位提供；
 * 而字段能被设置服务投影进表单的前提，是它们在 `Config` schema 里标了 `.volatile()`
 * （详见 `config.ts` 顶部的说明）。volatile 字段在运行期是引用对象，
 * 因此这里先用 `liveConfig()` 把配置透明化成普通值视图再交给下游 ——
 * 内部代码照旧按普通值读取，同时保留 Loader 的原地热更新语义。
 *
 * @module dsh-deepseek-web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { Config as ConfigSchema, PROVIDER } from './config.ts'
import { liveConfig } from './live-config.ts'
import { DeepSeekWebAdapter } from './adapter.ts'
import { PlaywrightBrowserChannel } from './playwright-channel.ts'
import { KimiBrowserChannel } from './kimi-channel.ts'
import { GLMChannel } from './glm-channel.ts'
import { DeepSeekSelfReviewer, GlmReviewer, KimiReviewer } from './reviewer.ts'

export const name = 'llm-deepseek-web'
export const inject = ['llm']

export { ConfigSchema as Config }

/**
 * 装配免费网页版主通道与可选审核通道。
 *
 * @param ctx - 插件上下文；`llm` 由 `inject` 保证就绪。
 * @param config - Loader 传入的配置；标 `.volatile()` 的字段此时是引用对象。
 */
export function apply(ctx: Context, config: Config): void {
  const live = liveConfig(config)
  const channel = new PlaywrightBrowserChannel({ config: live })
  const kimiChannel = new KimiBrowserChannel({ config: live.review, focus: live.focus })
  const glmChannel = new GLMChannel({ config: live.review, focus: live.focus })
  const kimiReviewer = new KimiReviewer(kimiChannel, live.review)
  const glmReviewer = new GlmReviewer(glmChannel, live.review)
  const selfReviewer = new DeepSeekSelfReviewer(channel)

  // 审核器按当前配置选择：kimi/glm = 独立窗口审核，deepseek-web = 同对话自审
  const reviewer = {
    get needsEvidence(): boolean {
      return live.review.provider !== 'deepseek-web'
    },
    review: (evidence: { task: string; artifact: string; files: string[] }) => {
      switch (live.review.provider) {
        case 'kimi': return kimiReviewer.review(evidence)
        case 'glm': return glmReviewer.review(evidence)
        default: return selfReviewer.review(evidence)
      }
    },
  }

  const adapter = new DeepSeekWebAdapter(live, channel, reviewer, (totals) => {
    console.info(
      `[llm-deepseek-web] 通道 token 累计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`,
    )
  })

  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER], adapter)
    return () => {
      unregister()
      void channel.dispose().catch(() => {})
      void kimiChannel.dispose().catch(() => {})
      void glmChannel.dispose().catch(() => {})
    }
  }, 'llm-deepseek-web')

  ctx.logger.info(
    `[llm-deepseek-web] provider "${PROVIDER}" registered`
    + ` (browser=${live.browser}, sendMode=${live.sendMode},`
    + ` review=${live.review.enabled ? live.review.provider : 'off'})`,
  )
}
