/**
 * 审核器：把任务目标与产出证据交给独立审核窗口（Kimi / GLM）或当前对话自审，
 * 统一返回结构化审核结论 `{ ok, issues, suggestions }`。
 *
 * - `KimiReviewer`：Kimi 网页窗口，需要外部证据（任务 + 产出 + 文件内容）
 * - `GlmReviewer`：chat.z.ai 网页窗口，同样需要外部证据
 * - `DeepSeekSelfReviewer`：复用正在工作的 DeepSeek 对话，只发一条自审指令
 *
 * @module dsh-deepseek-web/reviewer
 */

import type { BrowserChannel } from './browser-channel.ts'
import type { ReviewConfig } from './config.ts'

export const KIMI_REVIEW_SESSION = 'kimi-review'
export const GLM_REVIEW_SESSION = 'glm-review'

export interface ReviewEvidence {
  /** 用户原始任务。 */
  task: string
  /** 待审核的产出（回答正文、写入的文件内容、关键工具输出）。 */
  artifact: string
  /** 涉及的本地文件路径，供审核意见引用。 */
  files?: string[]
}

export interface ReviewVerdict {
  /** 是否通过审核。 */
  ok: boolean
  /** 发现的问题。 */
  issues: string[]
  /** 改进建议。 */
  suggestions: string[]
  /** 原始回复，便于排障。 */
  raw: string
}

export const REVIEW_PROTOCOL = `你是独立的代码与交付质量审核员。请审核给定任务的目标与产出是否一致。

只输出一个 JSON 对象，格式：
{"ok": true 或 false, "issues": ["问题1", "问题2"], "suggestions": ["建议1"]}

审核要点：
1. 产出是否真正满足任务目标，是否有遗漏或跑题；
2. 代码/文件是否存在明显错误、路径错误、未完成占位；
3. 是否缺少必要的验证（测试、运行结果、边界处理）；
4. 不要吹毛求疵，只报会导致返工的问题；没有问题时 ok=true、issues=[]。

重要：如果证据里出现“审核证据被截断”字样，那是审核通道自身的截断，不代表产出文件不完整；
不要因为该截断判定文件被截断或未完成。`

/** DeepSeek 同对话自审：不携带文件内容，直接要求它复查刚才的交付。 */
export const SELF_REVIEW_PROTOCOL = `[自审] 请审查你刚才给出的交付结果，不要重新实现任务。

只输出一个 JSON 对象：{"ok": true 或 false, "issues": ["问题1"], "suggestions": ["建议1"]}

自审要点：
1. 是否真正满足上一条用户任务的目标，有没有遗漏或跑题；
2. 交付的代码/文件是否完整、可运行，有没有截断、占位、路径错误；
3. 是否做过必要验证（运行结果、语法检查、边界情况）；
4. 没有会导致返工的问题就输出 ok=true、issues=[]。`

function clamp(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（已截断）`
}

export function buildReviewPrompt(evidence: ReviewEvidence, maxEvidenceChars: number): string {
  const files = evidence.files && evidence.files.length > 0
    ? `\n\n涉及文件：\n${evidence.files.map(file => `- ${file}`).join('\n')}`
    : ''
  return [
    REVIEW_PROTOCOL,
    `[任务目标]\n${clamp(evidence.task, Math.floor(maxEvidenceChars / 3))}`,
    `[待审核产出]\n${clamp(evidence.artifact, maxEvidenceChars)}${files}`,
  ].join('\n\n')
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i)
  const candidate = fenced ? fenced[1]!.trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        ok?: unknown
        issues?: unknown
        suggestions?: unknown
      }
      return {
        ok: parsed.ok === true,
        issues: Array.isArray(parsed.issues) ? parsed.issues.filter((v): v is string => typeof v === 'string') : [],
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions.filter((v): v is string => typeof v === 'string')
          : [],
        raw: text,
      }
    } catch {
      // 落到“无法解析=不通过”，把原文作为问题返回
    }
  }
  return { ok: false, issues: ['审核回复无法解析为 JSON'], suggestions: [], raw: text }
}

export class KimiReviewer {
  /** Kimi 审核需要外部证据（任务 + 产出 + 文件内容）。 */
  readonly needsEvidence = true

  private readonly channel: BrowserChannel
  private readonly config: ReviewConfig

  constructor(channel: BrowserChannel, config: ReviewConfig) {
    this.channel = channel
    this.config = config
  }

  /** 提交一次审核；需要用户在 Kimi 页面人工点击发送。 */
  async review(evidence: ReviewEvidence): Promise<ReviewVerdict> {
    await this.channel.ensureReady()
    const result = await this.channel.turn({
      sessionId: KIMI_REVIEW_SESSION,
      model: 'kimi-web',
      text: buildReviewPrompt(evidence, this.config.maxEvidenceChars),
      initialize: false,
    })
    return parseReviewVerdict(result.text)
  }
}

export class GlmReviewer {
  /** GLM 审核需要外部证据（任务 + 产出 + 文件内容）。 */
  readonly needsEvidence = true

  private readonly channel: BrowserChannel
  private readonly config: ReviewConfig

  constructor(channel: BrowserChannel, config: ReviewConfig) {
    this.channel = channel
    this.config = config
  }

  /** 提交一次审核；需要用户在 GLM 页面人工点击发送。 */
  async review(evidence: ReviewEvidence): Promise<ReviewVerdict> {
    await this.channel.ensureReady()
    const result = await this.channel.turn({
      sessionId: GLM_REVIEW_SESSION,
      model: 'glm-web',
      text: buildReviewPrompt(evidence, this.config.maxEvidenceChars),
      initialize: false,
    })
    return parseReviewVerdict(result.text)
  }
}

/**
 * DeepSeek 同对话自审：复用正在工作的网页对话，只发一条自审指令。
 * 不需要新窗口，也不需要重复粘贴文件内容——上下文里已经有产出。
 */
export class DeepSeekSelfReviewer {
  /** 自审不需要构造外部证据。 */
  readonly needsEvidence = false

  private readonly channel: BrowserChannel

  constructor(channel: BrowserChannel) {
    this.channel = channel
  }

  async review(evidence: ReviewEvidence): Promise<ReviewVerdict> {
    const goal = evidence.task.trim().slice(0, 300)
    const text = goal
      ? `${SELF_REVIEW_PROTOCOL}\n\n[任务目标（供对照）]\n${goal}`
      : SELF_REVIEW_PROTOCOL
    const result = await this.channel.turn({
      sessionId: 'deepseek-self-review',
      preserveConversation: true,
      model: 'deepseek-web',
      text,
      initialize: false,
    })
    return parseReviewVerdict(result.text)
  }
}
