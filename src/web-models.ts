/**
 * 网页版模型清单（Host 与 Client 半侧共享的最小事实表）。
 * 独立于 config.ts：客户端 bundle 的纯净度门禁禁止把 schemastery 等配置层依赖打进浏览器产物。
 *
 * @module dsh-deepseek-web/web-models
 */

/**
 * 网页版模型清单。DeepSeek 网页端已把极速/专家/识图合并为一个入口，
 * 模式与联网开关由页面自身管理。两个 id 的差别在发送方式：
 * - deepseek-web：半自动——填入消息后由用户人工点击发送
 * - deepseek-web-auto：全自动——填入消息后模拟回车自动发送
 */
export const WEB_MODEL_IDS = ['deepseek-web', 'deepseek-web-auto'] as const
export type WebModelId = typeof WEB_MODEL_IDS[number]

/** 网页版模型能力说明（模式由页面控制，字段仅用于展示）。 */
export interface WebModelCapability {
  /** 页面默认提供深度思考能力。 */
  thinking: boolean
  /** 页面默认提供联网搜索能力。 */
  search: boolean
  /** 页面展示名。 */
  label: string
}

export const WEB_MODEL_CAPABILITIES: Record<WebModelId, WebModelCapability> = {
  'deepseek-web': { thinking: true, search: true, label: 'DeepSeek 网页版（半自动）' },
  'deepseek-web-auto': { thinking: true, search: true, label: 'DeepSeek 网页版（全自动）' },
}
