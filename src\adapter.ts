/**
 * deepseek-web LlmAdapter：把网页版对话包装成 Harness 的流式模型调用。
 *
 * @module dsh-deepseek-web/adapter
 */

import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnProgress, BrowserTurnResult } from './browser-channel.ts'
import type { Config, WebModelId } from './config.ts'
import { normalizeWebModel, WEB_MODEL_CAPABILITIES, WEB_MODEL_IDS } from './config.ts'
import type { ActionProblem, WebToolAction } from './response.ts'
import {
  looksLikeIntendedToolReply,
  looksLikeTaskRequest,
  looksLikeToolDenial,
  parseWebReply,
  repairAndValidateActions,
  replyChunks,
} from './response.ts'
import {
  SYSTEM_PROTOCOL,
  buildDelegationPrompt,
  buildHandoffBrief,
  buildRecoveryPrompt,
  buildToolCatalog,
  renderNewWebMessages,
  visibleToolsOf,
} from './protocol.ts'
import { buildReviewEvidence } from './protocol.ts'
import { SessionRegistry, type ChannelTokenTotals, type WebChatState } from './session-state.ts'
import type { ReviewVerdict } from './reviewer.ts'
import os from 'node:os'
import path from 'node:path'

/** 拆出委托动作（如 web_search/web_fetch）：本地校验与执行都不含它们。 */
function splitDelegatedActions(
  actions: readonly WebToolAction[],
  delegated: ReadonlySet<string>,
): WebToolAction[] {
  if (delegated.size === 0) return []
  return actions.filter((action) => {
    const name = action.tool ?? action.action
    return typeof name === 'string' && delegated.has(name)
  })
}

const CONTEXT_WINDOW = 128_000
const MAX_TOKENS = 16_000

/** 产出签名：同一任务下内容未变就不重复送审。 */
function reviewSignature(goal: string, artifact: string): string {
  const input = `${goal.length}:${goal.slice(0, 200)}|${artifact.length}:${artifact.slice(0, 200)}`
  let hash = 5381
  for (let index = 0; index < input.length; index++) {
    hash = ((hash * 33) ^ input.charCodeAt(index)) >>> 0
  }
  return `${hash.toString(16)}-${artifact.length}`
}

/** 审核器最小接口；KimiReviewer / GlmReviewer / DeepSeekSelfReviewer 均满足该结构。 */
type ReviewerLike = {
  readonly needsEvidence: boolean
  review: (evidence: { task: string; artifact: string; files: string[] }) => Promise<ReviewVerdict>
}

/**
 * 网页实时增量的缓冲管道：onProgress 回调把 chunk 推进来，
 * driveTurn 的消费循环在等待网页回复的同时把它们 yield 给 Harness。
 */
class TurnProgressPipe {
  private readonly buffer: StreamChunk[] = []
  private waiters: Array<() => void> = []

  push(chunk: StreamChunk): void {
    this.buffer.push(chunk)
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  /** 把一次网页增量翻译成 reasoning 流 chunk。 */
  pushProgress(progress: BrowserTurnProgress, index: number): void {
    if (progress.reasoning) this.push({ type: 'reasoning-delta', index, text: progress.reasoning })
    if (progress.text) this.push({ type: 'reasoning-delta', index, text: progress.text })
  }

  /** 等待下一次 push（buffer 为空时阻塞；push 会同步唤醒）。 */
  wait(): Promise<void> {
    if (this.buffer.length > 0) return Promise.resolve()
    return new Promise(resolve => { this.waiters.push(resolve) })
  }

  takeAll(): readonly StreamChunk[] {
    if (this.buffer.length === 0) return []
    const chunks = [...this.buffer]
    this.buffer.length = 0
    return chunks
  }
}

export class DeepSeekWebAdapter extends LlmAdapter {
  private readonly sessions: SessionRegistry
  private readonly config: Config
  private readonly channel: BrowserChannel
  private readonly reviewer?: ReviewerLike
  /** 每轮记账后的总量回调（宿主用于把总计推送到前端展示）。 */
  private readonly onUsage?: (totals: ChannelTokenTotals) => void

  constructor(
    config: Config,
    channel: BrowserChannel,
    reviewer?: ReviewerLike,
    onUsage?: (totals: ChannelTokenTotals) => void,
  ) {
    super()
    this.config = config
    this.channel = channel
    this.reviewer = reviewer
    this.onUsage = onUsage
    const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const defaultStateFile = config.stateFile
      ?? path.join(appDataRoot, 'DshDeepSeekWeb', 'session-state.json')
    this.sessions = new SessionRegistry({ file: defaultStateFile })
  }

  /** 读取通道 token 用量总计（宿主注册设置命名空间时用作初始值）。 */
  getChannelTotals(): ChannelTokenTotals {
    return this.sessions.getChannelTotals()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek Web（免费网页版）' }
  }

  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      WEB_MODEL_IDS.map((id: WebModelId) => {
        const cap = WEB_MODEL_CAPABILITIES[id]!
        return {
          provider: 'deepseek-web',
          id,
          name: cap.label,
          description: '通过你的 DeepSeek 网页账号对话；模式（极速/专家/识图、深度思考、联网）由网页端自行选择。',
          inputModalities: ['text'],
        }
      }),
    )
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const normalized = normalizeWebModel(model)
    if (!normalized) {
      throw new LlmError(`deepseek-web: 未知网页模型 ${model}`, 'UNKNOWN_MODEL')
    }
    return {
      provider,
      id: model,
      name: WEB_MODEL_CAPABILITIES[normalized]!.label,
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_TOKENS,
    }
  }

  /**
   * 驱动一轮网页对话：等待回复期间，把网页端的流式增量作为 reasoning 块
   * 实时 yield 给 Harness（思考流），而不是只在回合结束时一次性给出。
   *
   * `blocks.next` 是本次 stream() 内下一个空闲内容块序号：每次 driveTurn
   * 消耗一个 reasoning 块并自增；调用方最后把它作为正文/工具块的起始序号，
   * 保证同一条助手消息内所有块序号互不冲突。
   */
  private async *driveTurn(
    request: Omit<BrowserTurnRequest, 'onProgress'>,
    blocks: { next: number },
  ): AsyncGenerator<StreamChunk, BrowserTurnResult> {
    const pipe = new TurnProgressPipe()
    const reasoningIndex = blocks.next++
    let opened = false
    let reasoningText = ''
    const turnPromise = this.channel.turn({
      ...request,
      onProgress: (progress) => {
        if (this.config.liveThinking === false) return
        if (!opened) {
          opened = true
          pipe.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
          pipe.push({ type: 'reasoning-delta', index: reasoningIndex, text: '⏳ 网页版生成中（实时）：\n' })
        }
        reasoningText += progress.reasoning + progress.text
        pipe.pushProgress(progress, reasoningIndex)
      },
    }).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    )
    for (;;) {
      for (const chunk of pipe.takeAll()) yield chunk
      const raced = await Promise.race([
        turnPromise,
        pipe.wait().then(() => 'progress' as const),
      ])
      if (raced === 'progress') continue
      for (const chunk of pipe.takeAll()) yield chunk
      if (opened) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
      }
      if (!raced.ok) throw raced.error
      return raced.value
    }
  }

  /**
   * driveTurn 的自动轮换包装：网页端提示对话长度达到上限时，生成任务简报、
   * 轮换到全新网页对话，并以「协议 + 工具目录 + 任务简报 + 原消息」重发本轮（仅重试一次）。
   */
  private async *driveTurnAuto(
    request: Omit<BrowserTurnRequest, 'onProgress'>,
    blocks: { next: number },
    state: WebChatState,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk, BrowserTurnResult> {
    const reply = yield* this.driveTurn(request, blocks)
    if (reply.contextLengthExceeded !== true) return reply

    console.info('[deepseek-web] 网页提示对话长度达到上限，生成任务简报并轮换新对话…')
    const brief = buildHandoffBrief(options, state)
    // 原消息若已带协议前缀则剥掉，避免与新对话首条消息里的协议重复
    const bodyText = request.text.startsWith(SYSTEM_PROTOCOL)
      ? request.text.slice(SYSTEM_PROTOCOL.length).replace(/^(?:\r?\n)+/, '')
      : request.text
    const catalog = buildToolCatalog(visibleToolsOf(options, this.config), this.config.compactToolCatalog)
    const retryText = [
      SYSTEM_PROTOCOL,
      catalog && `当前任务上下文可用的工具：\n${catalog}`,
      brief,
      bodyText,
    ].filter(Boolean).join('\n\n')

    await this.channel.startNewConversation?.()
    // 新网页对话从零累计：token 基线清零；协议已随重发注入
    state.usageBaseline = 0
    state.roundsSinceProtocol = 0

    const retry = yield* this.driveTurn({ ...request, text: retryText, initialize: true }, blocks)
    if (retry.contextLengthExceeded === true) {
      throw new LlmError(
        'deepseek-web: 轮换到新对话后仍提示达到长度上限，请人工检查网页状态。',
        'WEB_CONTEXT_LENGTH_AGAIN',
      )
    }
    console.info('[deepseek-web] 已在新对话注入任务简报并完成本轮重发。')
    return retry
  }

  /**
   * 记录一轮网页回复上报的会话累计 token 用量（accumulated_token_usage），
   * 返回本轮增量。新网页对话（initialize）基线为 0；dsh 重启后附着到已有
   * 网页对话的首个观测值只作基线、不计增量（之前轮次的消耗无法回溯）。
   */
  private accountUsage(reply: BrowserTurnResult, state: WebChatState, initialize: boolean): number {
    const accumulated = reply.accumulatedUsage
    if (typeof accumulated !== 'number' || !Number.isFinite(accumulated)) return 0
    const baseline = typeof state.usageBaseline === 'number'
      ? state.usageBaseline
      : initialize ? 0 : accumulated
    state.usageBaseline = accumulated
    return Math.max(0, Math.round(accumulated - baseline))
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const sessionId = options.sessionId ?? 'anonymous'
    await this.sessions.load()
    const model = options.model as WebModelId
    if (!normalizeWebModel(model)) {
      throw new LlmError(`deepseek-web: 未知网页模型 ${options.model}`, 'UNKNOWN_MODEL')
    }
    // 全自动模型（deepseek-web-auto）：填入后模拟回车发送，焦点全程留在 dsh；
    // 半自动（deepseek-web）：填入后网页置顶聚焦，等人工回车/点击。
    const autoSend = model === 'deepseek-web-auto'
    this.channel.setSessionAutoSend?.(sessionId, autoSend)
    this.channel.setSessionAutoSend?.('deepseek-self-review', autoSend)

    await this.channel.ensureReady()

    const state = this.sessions.for(sessionId)

    const goalBefore = state.goalText
    const rendered = renderNewWebMessages(options, state, this.config)
    if (state.goalText !== goalBefore) {
      // 新的用户任务：重置审核计数
      state.reviewRoundsUsed = 0
      state.reviewedSignature = undefined
    }
    if (!rendered) {
      // 无新增内容却要求生成：直接让模型空转一次也不会损坏会话
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // 乐观标记：首轮即将进入网页对话，先置 initialized 并落盘，
    // 防止后续工具轮次因状态错位再次触发“开启新对话”。
    if (rendered.prompt.initialize && !state.initialized) {
      this.channel.resetConversationGate()
      state.initialized = true
      await this.sessions.save()
    }

    // 需要人工/浏览器确认的轮次在 turn() 内部完成；异常时给出可诊断错误。
    // blocks 记录本次助手消息的内容块序号水位：实时思考流每轮占一个块。
    const blocks = { next: 0 }
    // 本轮（一次模型调用）内各网页回合上报的 token 用量增量之和
    let usageDeltaSum = 0
    let usageObserved = false
    let reply: BrowserTurnResult
    try {
      reply = yield* this.driveTurnAuto({
        sessionId,
        model,
        text: rendered.prompt.text,
        initialize: rendered.prompt.initialize,
        autoSend,
        signal: options.signal,
      }, blocks, state, options)
      usageDeltaSum += this.accountUsage(reply, state, rendered.prompt.initialize)
      usageObserved = usageObserved || reply.accumulatedUsage !== undefined
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `deepseek-web: 网页对话失败: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_TURN_FAILED',
        { cause: error },
      )
    }

    let parsed = parseWebReply(reply.text)
    const visibleTools = visibleToolsOf(options, this.config)
    const allowedToolNames = new Set(visibleTools.map(tool => tool.name))
    const toolSchemas = new Map(visibleTools.map(tool => [tool.name, tool]))
    // 委托工具（如 web_search/web_fetch）不进入本地校验与执行：
    // 拆分后在下一轮把查询转交网页端自带能力，结果并入正文。
    const delegatedNames = new Set(this.config.delegatedTools)
    let delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames)
    let problems: ActionProblem[] = []
    let correctedChars = 0
    let delegatedChars = 0
    let delegatedTurns = 0

    const revalidate = (): void => {
      delegatedActions = splitDelegatedActions(parsed.actions, delegatedNames)
      const delegatedSet = new Set(delegatedActions)
      const local = parsed.actions.filter(action => !delegatedSet.has(action))
      const outcome = parsed.hasActions && (local.length > 0 || delegatedActions.length === 0)
        ? repairAndValidateActions(local, allowedToolNames, toolSchemas)
        : { actions: local, problems: [] as ActionProblem[] }
      parsed = { ...parsed, actions: outcome.actions, hasActions: local.length > 0 }
      problems = outcome.problems
    }
    revalidate()

    /**
     * 游标只在完整 chunk 流交给上层之后再落盘：
     * 进程若在回合中途被杀，游标不会超前于 Harness 会话日志。
     */
    const advanceAndSave = async (): Promise<void> => {
      state.lastMessageId = options.messages.at(-1)?.id
      state.roundsSinceProtocol = rendered.prompt.includeProtocol ? 0 : state.roundsSinceProtocol + 1
      state.lastReply = reply.text
      await this.sessions.save()
    }

    // 格式漂移自愈：明显是想调工具但没给出合法 JSON 时，注入纠错再等一轮人工发送。
    // 委托动作是合法意图（本地不执行），不触发纠错。
    if (
      this.config.autoCorrectMalformed !== false
      && delegatedActions.length === 0
      && (
        problems.length > 0
        || (
          !parsed.hasActions
          && (
            looksLikeIntendedToolReply(reply.text)
            || looksLikeTaskRequest(reply.text)
            || ((options.tools?.length ?? 0) > 0 && looksLikeToolDenial(reply.text))
          )
        )
      )
    ) {
      const reviewNote = problems.length > 0
        ? `\n\n本地审查未通过，请修正后重新输出：\n${
          problems.map(item => `- actions[${item.index}]${item.tool ? ` (${item.tool})` : ''}: ${item.problem}`).join('\n')
        }`
        : ''
      let correctedReply
      try {
        correctedReply = yield* this.driveTurnAuto({
          sessionId,
          model,
          text: `${buildRecoveryPrompt(options, state, this.config)}${reviewNote}`,
          initialize: false,
          autoSend,
          signal: options.signal,
        }, blocks, state, options)
      } catch (error) {
        throw new LlmError(
          'deepseek-web: 已请求模型纠正输出格式，但等待网页发送超时。'
          + '请在浏览器中点击发送以完成纠错。',
          'WEB_CORRECTION_TIMEOUT',
          { cause: error },
        )
      }
      usageDeltaSum += this.accountUsage(correctedReply, state, false)
      usageObserved = usageObserved || correctedReply.accumulatedUsage !== undefined
      reply = correctedReply
      parsed = parseWebReply(correctedReply.text)
      revalidate()
      correctedChars += correctedReply.text.length + reviewNote.length
    }

    if (problems.length > 0) {
      console.warn(
        '[deepseek-web] 本地审查拒绝执行，模型原始输出：',
        reply.text.slice(0, 800),
      )
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `本地审查拒绝执行：${
              problems.map(item => `actions[${item.index}]${item.tool ? ` (${item.tool})` : ''} ${item.problem}`).join('；')
            }`,
            code: 'WEB_ACTION_REJECTED',
          },
        },
      }
      return
    }

    // 网页委托：把委托动作转成下一轮提示词，交给网页端自带能力执行（如联网搜索/网页阅读），
    // 每次委托多一轮人工发送；结果并入正文，本地动作照常交给 Harness 执行。
    if (delegatedActions.length > 0) {
      const sections: string[] = []
      for (const action of delegatedActions) {
        const name = action.tool ?? action.action ?? ''
        const prompt = buildDelegationPrompt(name, action)
        if (!prompt) {
          console.warn('[deepseek-web] 委托动作缺少可识别参数，已跳过：', name)
          continue
        }
        let outcome
        try {
          outcome = yield* this.driveTurnAuto({
            sessionId,
            model,
            text: prompt,
            initialize: false,
            autoSend,
            signal: options.signal,
          }, blocks, state, options)
        } catch (error) {
          throw new LlmError(
            `deepseek-web: 工具委托轮失败（${name}）。请在浏览器中点击发送以完成委托。: ${error instanceof Error ? error.message : String(error)}`,
            'WEB_DELEGATION_FAILED',
            { cause: error },
          )
        }
        usageDeltaSum += this.accountUsage(outcome, state, false)
        usageObserved = usageObserved || outcome.accumulatedUsage !== undefined
        const outcomeParsed = parseWebReply(outcome.text)
        const body = outcomeParsed.text.length > this.config.maxToolResultChars
          ? `${outcomeParsed.text.slice(0, this.config.maxToolResultChars)}…（委托结果过长，已截断）`
          : outcomeParsed.text
        sections.push(`[${name} 委托结果]\n${body}`)
        delegatedChars += prompt.length + outcome.text.length
        delegatedTurns += 1
      }
      if (sections.length > 0) {
        parsed = { ...parsed, text: `${parsed.text}\n\n---\n${sections.join('\n\n')}` }
      }
    }

    // 可选审核（Kimi / GLM / DeepSeek 自审）：仅对“最终正文”生效，最多审核 maxRounds 轮。
    // 结论名称按当前审核器动态生成，避免固定写成 Kimi。
    const reviewLabel = this.config.review.provider === 'kimi' ? 'Kimi'
      : this.config.review.provider === 'glm' ? 'GLM'
      : 'DeepSeek'
    let reviewSummary: string | undefined
    if (
      !parsed.hasActions
      && this.reviewer
      && this.config.review.enabled
      && this.config.review.maxRounds > 0
      && state.reviewRoundsUsed < this.config.review.maxRounds
      && state.reviewedSignature !== reviewSignature(state.goalText ?? '', parsed.text)
    ) {
      let reviewRound = 0
      while (reviewRound < this.config.review.maxRounds) {
        reviewRound++
        const signature = reviewSignature(state.goalText ?? '', parsed.text)
        const evidence = this.reviewer.needsEvidence
          ? await buildReviewEvidence(options, state, parsed.text, this.config.review.maxEvidenceChars)
          : { task: state.goalText ?? '', artifact: '', files: [] }
        let verdict: ReviewVerdict
        try {
          verdict = await this.reviewer.review(evidence)
        } catch (error) {
          console.warn(`[deepseek-web] ${reviewLabel} 审核失败，跳过本轮审核：`, error instanceof Error ? error.message : error)
          break
        }
        state.reviewRoundsUsed += 1
        state.reviewedSignature = signature
        console.info(`[deepseek-web] ${reviewLabel} 审核结果：ok=${verdict.ok} issues=${verdict.issues.length}`)
        if (verdict.ok) {
          reviewSummary = [
            `✅ ${reviewLabel} 审核：通过`,
            verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join('；')}` : '',
          ].filter(Boolean).join('\n')
          break
        }
        reviewSummary = [
          `⚠️ ${reviewLabel} 审核（首版）：未通过，已回注修正`,
          verdict.issues.length > 0 ? `问题：${verdict.issues.slice(0, 3).join('；')}` : '',
          verdict.suggestions.length > 0 ? `建议：${verdict.suggestions.slice(0, 3).join('；')}` : '',
        ].filter(Boolean).join('\n')
        const feedback = [
          '[审核反馈] 独立审核员认为当前产出未通过审核，请修正后重新输出。',
          verdict.issues.length > 0 ? `问题：\n${verdict.issues.map(item => `- ${item}`).join('\n')}` : '',
          verdict.suggestions.length > 0 ? `建议：\n${verdict.suggestions.map(item => `- ${item}`).join('\n')}` : '',
          state.goalText ? `[当前用户任务]\n${state.goalText}` : '',
          '若需要调用工具，请只输出 JSON 动作；否则输出修正后的最终正文。',
        ].filter(Boolean).join('\n\n')
        const revised = yield* this.driveTurnAuto({
          sessionId,
          model,
          text: feedback,
          initialize: false,
          autoSend,
          signal: options.signal,
        }, blocks, state, options)
        usageDeltaSum += this.accountUsage(revised, state, false)
        usageObserved = usageObserved || revised.accumulatedUsage !== undefined
        reply = revised
        parsed = parseWebReply(revised.text)
        revalidate()
        correctedChars += revised.text.length + feedback.length
        if (problems.length > 0) break
        if (parsed.hasActions) break
      }
    }

    // 把审核结论附在最终正文末尾，让 Harness 对话里可见
    if (reviewSummary && !parsed.hasActions) {
      parsed = { ...parsed, text: `${parsed.text}\n\n---\n${reviewSummary}` }
    }

    // 网页对话（含审核）完全结束、正文即将交给 Harness 呈现给用户时：
    // 半自动——取消网页置顶并把 dsh 窗口带到最前；全自动——焦点全程留在 dsh，不动窗口。
    if (!parsed.hasActions) {
      if (autoSend) {
        // 全自动不做任何窗口切换
      } else {
        await this.channel.setWebWindowTopmost?.(sessionId, false).catch(() => {})
        if (this.config.focus?.enabled !== false && this.config.focus?.dshWindow !== false) {
          await this.channel.focusHarness().catch(() => {})
        }
      }
    }

    if (parsed.hasActions) {
      state.lastParseOk = true
    } else {
      state.lastParseOk = false
    }

    if (usageObserved) {
      const totals = usageDeltaSum > 0
        ? this.sessions.addChannelTokens(usageDeltaSum)
        : this.sessions.getChannelTotals()
      this.onUsage?.(totals)
      console.info(
        `[deepseek-web] 本轮 token 用量：${usageDeltaSum}（网页会话累计 ${String(state.usageBaseline)}），`
        + `通道总计：${totals.totalTokens} tokens / ${totals.usageTurns} 轮`,
      )
      if (usageDeltaSum > 0) {
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: usageDeltaSum, totalTokens: usageDeltaSum } }
      }
    }

    yield* replyChunks(parsed, { startIndex: blocks.next, nextCallId: 1 })
    await advanceAndSave()
  }
}
