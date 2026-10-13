/**
 * 基于 Playwright-core 的真实浏览器通道（有头 Edge/Chrome，无扩展）。
 *
 * 工作方式：
 * 1. managed：插件用独立 user-data-dir 启动有头 Edge/Chrome 并打开 chat.deepseek.com；
 *    用户在该窗口用自己的账号登录一次，登录态持久保存在 profile。dsh 的每个新对话
 *    都复用这个浏览器窗口和当前 Page，通过网页“新对话”入口切换，不新开浏览器。
 * 2. attach：连接用户已经以 `--remote-debugging-port` 启动的浏览器。
 * 3. 每一轮：驱动把下一条消息填入输入框并前置窗口，由用户人工点击“发送”。
 * 4. 驱动监听该页面随后的 chat/completions 类网络响应，等流结束并解析正文，
 *    不依赖网页 DOM 的私有类名来读取回答。
 *
 * @module dsh-deepseek-web/playwright-channel
 */

import { type Browser, type BrowserContext, type Page } from 'playwright-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from './browser-channel.ts'
import type { Config, WebModelId } from './config.ts'
import { WEB_MODEL_CAPABILITIES } from './config.ts'
import {
  bestEffortNewChat,
  connectBrowser,
  defaultProfileDir,
  focusDshWindow,
  hasRateLimitToast,
  looksLikeRateLimitText,
  looksLoggedOut,
  locateEditor,
  ensureChatPage,
  setBrowserWindowTopmost,
  launchManagedBrowser,
  type ManagedBrowserConnection,
} from './browser-shared.ts'

/** 频控 toast / 实时增量的轮询间隔。 */
const POLL_INTERVAL_MS = 800
/** 页面网络镜像保留的最近请求数。 */
const CAPTURE_KEEP = 20
/** 增量里的原始流特征（SSE 帧 / DeepSeek 网页协议字段），出现即说明捕获错了流。 */
const POLLUTION_PATTERN = /(^|\n)\s*(event:\s*\w+|data:\s*\{)|request_message_id/

interface ChatCompletionResponse {
  url: string
  request: {
    postData?: string
  }
  status: number
  body: string
}

export interface PlaywrightChannelOptions {
  config: Config
  /** 显式指定 profile 目录（测试/工具脚本用）。 */
  profileDir?: string
}

function matchesCompletionUrl(url: string): boolean {
  return /\/chat\/completion\b/i.test(url)
    || /\/chat\/completions?$/i.test(url)
    || /\/conversation\/(chat|completion)/i.test(url)
}

/** 从 SSE / JSON body 里抽取模型可见正文与思考内容。 */
export function parseCompletionBody(body: string): {
  text: string
  reasoning?: string
  reliable: boolean
  /** 网页端上报的会话累计 token 用量（accumulated_token_usage，BATCH/全量补丁里的最大值）。 */
  accumulatedUsage?: number
  /** 网页端提示对话长度达到上限（finish_reason=context_length_exceeded）。 */
  contextLengthExceeded?: boolean
} {
  interface LiveFragment {
    id?: number
    type: string
    content: string
  }
  // DeepSeek 网页端把回复组织成“fragments 数组 + JSON Pointer 补丁”，
  // 见 README.md 的协议说明。这里重建出完整 fragments。
  const fragments: LiveFragment[] = []
  let untrackedText = ''
  let untrackedReasoning = ''
  let lastPatchPath: string | undefined
  let lastPatchOp = 'APPEND'
  let accumulatedUsage: number | undefined
  let contextLengthExceeded = false

  /** 记录网页端上报的会话累计 token 用量（只增不减时取最新）。 */
  function observeUsage(value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      accumulatedUsage = value
    }
  }

  function upsertFragment(fragment: LiveFragment, mode: 'replace' | 'append'): void {
    const index = fragment.id === undefined
      ? -1
      : fragments.findIndex(item => item.id === fragment.id)
    if (index >= 0) {
      const current = fragments[index]!
      current.type = fragment.type || current.type
      current.content = mode === 'replace' ? fragment.content : current.content + fragment.content
    } else {
      fragments.push({ ...fragment })
    }
  }

  function collectFullResponse(json: unknown): void {
    const root = json as {
      v?: { response?: { fragments?: LiveFragment[]; accumulated_token_usage?: unknown } }
    }
    if (root.v?.response?.accumulated_token_usage !== undefined) {
      observeUsage(root.v.response.accumulated_token_usage)
    }
    const fragmentList = root.v?.response?.fragments
    if (!Array.isArray(fragmentList)) return
    for (const fragment of fragmentList) {
      if (typeof fragment.content !== 'string') continue
      // 整段 upsert：同一 id 视为服务端发来的最新完整内容
      upsertFragment({
        id: fragment.id,
        type: String(fragment.type ?? ''),
        content: fragment.content,
      }, 'replace')
    }
  }

  function lastFragmentIndex(): number {
    for (let i = fragments.length - 1; i >= 0; i--) {
      if ((fragments[i]?.type ?? '').toUpperCase() !== 'THINK') return i
    }
    return fragments.length - 1
  }

  function applyPatch(payload: Record<string, unknown>): void {
    const pointer = typeof payload.p === 'string' ? payload.p : lastPatchPath
    const op = typeof payload.o === 'string' ? payload.o : lastPatchOp
    const value = payload.v
    if (!pointer) return
    lastPatchPath = pointer
    lastPatchOp = op

    if (pointer === 'response/fragments' && op === 'APPEND' && Array.isArray(value)) {
      for (const fragment of value as LiveFragment[]) {
        if (fragment && typeof fragment === 'object' && typeof fragment.content === 'string') {
          upsertFragment(fragment, 'replace')
        }
      }
      return
    }

    if (pointer === 'response/fragments/-1/content') {
      const index = lastFragmentIndex()
      if (index >= 0 && typeof value === 'string') {
        const fragment = fragments[index]!
        fragment.content += value
      }
      return
    }

    // BATCH 补丁：{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":N},…]}
    // 目前只提取 token 用量，其余子补丁不影响正文重建。
    if (op === 'BATCH' && Array.isArray(value)) {
      for (const item of value as Array<{ p?: unknown; v?: unknown }>) {
        if (item && item.p === 'accumulated_token_usage') observeUsage(item.v)
      }
      return
    }

    // SET 类补丁（status、token 计数等）不影响正文重建，忽略即可。
  }

  function consumeFragments(): void {
    for (const fragment of fragments) {
      const type = String(fragment.type ?? '').toUpperCase()
      if (type === 'RESPONSE' || type === 'TEXT' || type === 'CONTENT' || type === '') {
        untrackedText += fragment.content
      } else if (type === 'THINK' || type === 'THINKING' || type === 'REASONING' || type === 'THOUGHT') {
        untrackedReasoning += fragment.content
      }
    }
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    // 兼容 "event: hint data: {…}" 同行形态：从首个 data: 起取载荷
    const dataIdx = line.indexOf('data:')
    if (dataIdx < 0) continue
    const payload = line.slice(dataIdx + 5).trim()
    if (!payload || payload === '[DONE]') continue
    let json: Record<string, unknown>
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }

    if (json && typeof json === 'object' && 'p' in json) {
      applyPatch(json)
      continue
    }

    // 网页端长度上限提示：event: hint → {"finish_reason":"context_length_exceeded",…}
    if (
      (json as { finish_reason?: unknown }).finish_reason === 'context_length_exceeded'
      || (
        (json as { type?: unknown }).type === 'error'
        && String((json as { content?: unknown }).content ?? '').includes('对话长度上限')
      )
    ) {
      contextLengthExceeded = true
      continue
    }

    if (json.v && typeof json.v === 'object' && (json.v as { response?: unknown }).response) {
      collectFullResponse(json)
      continue
    }

    // 只有 {"v": "..."}：服务端对上一个 APPEND 补丁的连续增量
    if (!('p' in json) && Object.keys(json).length <= 1 && 'v' in json && lastPatchPath) {
      applyPatch({ ...json })
      continue
    }

    if (Array.isArray((json as { choices?: unknown }).choices)) {
      const choiceJson = json as unknown as {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string; reasoner?: string }
          message?: { content?: string; reasoning_content?: string }
        }>
      }
      for (const choice of choiceJson.choices ?? []) {
        const delta = choice.delta
        const message = choice.message
        if (typeof message?.content === 'string') untrackedText += message.content
        if (typeof message?.reasoning_content === 'string') untrackedReasoning += message.reasoning_content
        if (typeof delta?.content === 'string') untrackedText += delta.content
        const think = delta?.reasoning_content ?? delta?.reasoner
        if (typeof think === 'string') untrackedReasoning += think
      }
    }
  }

  consumeFragments()
  if (untrackedText || untrackedReasoning) {
    return {
      text: untrackedText.trim(),
      ...untrackedReasoning.trim() ? { reasoning: untrackedReasoning.trim() } : {},
      reliable: true,
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    }
  }

  try {
    const json = JSON.parse(body) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string }
        text?: string
      }>
      content?: string
    }
    let fallbackText = ''
    let fallbackReasoning = ''
    for (const choice of json.choices ?? []) {
      if (typeof choice.message?.content === 'string') fallbackText += choice.message.content
      if (typeof choice.message?.reasoning_content === 'string') fallbackReasoning += choice.message.reasoning_content
      if (typeof choice.text === 'string') fallbackText += choice.text
    }
    if (typeof json.content === 'string') fallbackText += json.content
    if (fallbackText.trim() || fallbackReasoning.trim()) {
      return {
        text: fallbackText.trim(),
        ...fallbackReasoning.trim() ? { reasoning: fallbackReasoning.trim() } : {},
        reliable: true,
        ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
        ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
      }
    }
    // 结构化解析一无所获：不可靠，调用方（实时轮询）必须丢弃
    return {
      text: '',
      reliable: false,
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    }
  } catch {
    // body 不是可解析的结构化载荷（例如误捕获的状态/心跳流）：原始内容不可信
    return {
      text: body.trim(),
      reliable: false,
      ...accumulatedUsage !== undefined ? { accumulatedUsage } : {},
      ...contextLengthExceeded ? { contextLengthExceeded: true } : {},
    }
  }
}

export class PlaywrightBrowserChannel implements BrowserChannel {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  /** 当前页面是否已经承载过 agent 对话；同一浏览器进程内只新建一次对话。 */
  private conversationStarted = false
  /** 页面原始标题，用于状态标记前缀的清除/还原。 */
  private originalTitle: string | undefined
  private readonly options: PlaywrightChannelOptions
  private readonly profileDir: string
  private managedConnection: ManagedBrowserConnection | undefined

  constructor(options: PlaywrightChannelOptions) {
    this.options = options
    this.profileDir = options.profileDir
      ?? options.config.profileDir
      ?? defaultProfileDir('edge-profile')
  }

  async ensureReady(): Promise<void> {
    if (this.browser && this.page) return

    if (this.options.config.browser === 'attach') {
      // 连接（必要时自动拉起）浏览器常驻守护，逻辑集中在 browser-shared 的 connectBrowser
      const { browser, context } = await connectBrowser({
        port: this.options.config.debugPort,
        profileDir: this.profileDir,
        url: this.options.config.url,
        autoStartKeeper: this.options.config.autoStartKeeper,
        label: 'deepseek-web',
      })
      this.browser = browser
      this.context = context
    } else {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(this.profileDir, { recursive: true })
      this.managedConnection = await launchManagedBrowser({
        channel: this.options.config.channel,
        profileDir: this.profileDir,
        preferredPort: this.options.config.debugPort,
        url: this.options.config.url,
        label: 'deepseek-web',
      })
      this.browser = this.managedConnection.browser
      this.context = this.managedConnection.context
    }

    const pages = this.context.pages()
    this.page = pages.find(p => p.url().startsWith(new URL(this.options.config.url).origin))
      ?? pages[0]
      ?? await this.context.newPage()
    // managed profile 只由本插件使用：保留一个工作标签，关闭启动器或旧版本
    // 残留的空白/重复标签，避免首次请求同时出现两个网页。attach 模式不碰
    // 用户自己打开的其他标签。
    if (this.options.config.browser === 'managed') {
      await Promise.all(pages.filter(page => page !== this.page).map(page => page.close().catch(() => {})))
    }

    await ensureChatPage(this.page, this.options.config.url)
    // 等待前端登录态/编辑器出现
    await this.page.waitForTimeout(1_500)

    if (await looksLoggedOut(this.page)) {
      throw new LlmError(
        'deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。'
        + '请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。',
        'WEB_LOGIN_REQUIRED',
      )
    }
  }

  resetConversationGate(): void {
    // 新的 dsh 会话开始时由 adapter 调用；仅解除“同一页面已开始对话”限制。
    this.conversationStarted = false
  }

  /** 轮换到全新网页对话（上下文长度达到上限时由 adapter 调用）。 */
  async startNewConversation(): Promise<void> {
    // 只切换当前 Page 内的网页会话；不要创建新 Browser、BrowserContext 或 Page。
    if (!this.page) await this.ensureReady()
    const page = this.page!
    this.originalTitle = undefined
    await this.startFreshConversation(page)
    this.conversationStarted = true
  }

  /**
   * 确保网页端切到一个全新对话。
   *
   * 先尝试点击侧栏入口；若点击失败或 URL 未变化，则回退为重新打开入口页，
   * 强制落到全新对话，避免沿用上一次的网页会话（全自动模式下的典型问题）。
   */
  private async startFreshConversation(page: Page): Promise<void> {
    const beforeUrl = page.url()
    const existingPages = new Set(page.context().pages())
    const clicked = await bestEffortNewChat(page)
    await page.waitForTimeout(800)
    // 某些网页版本会把“新对话”按钮实现成新标签。插件要求所有 dsh 对话
    // 复用同一个网页标签，因此关闭点击产生的额外标签并回退到当前页面。
    await Promise.all(page.context().pages().filter(candidate => candidate !== page && !existingPages.has(candidate))
      .map(candidate => candidate.close().catch(() => {})))
    if (clicked && page.url() !== beforeUrl) {
      console.info('[deepseek-web] 已切换到新对话。')
    } else {
      console.warn('[deepseek-web] 未能确认切换到新对话，回退为重新打开入口页以强制新会话。')
      await page.goto(this.options.config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
      await page.waitForTimeout(1_000)
    }
    // 新对话页/入口页是 SPA：导航完成后编辑器可能滞后渲染，等待它出现再返回
    await locateEditor(page).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  }

  private async markPageStatus(page: Page, marker: string | undefined): Promise<void> {
    if (this.originalTitle === undefined) {
      this.originalTitle = await page.title()
    }
    const clean = this.originalTitle.replace(/^\[dsh[^\]]*\]\s*/u, '')
    await page.evaluate(({ title, prefix }) => {
      document.title = prefix ? `${prefix} ${title}` : title
    }, { title: clean, prefix: marker })
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    if (!this.page) await this.ensureReady()
    const page = this.page!

    // 诊断：新开 dsh 会话却沿用旧网页对话时，这三项值可直接定位问题：
    // initialize=false 表示 adapter 侧根本没触发初始化分支（sessionId/状态问题）；
    // initialize=true 且 conversationStarted=true 表示闸门没被 resetConversationGate 重置。
    console.info(
      `[deepseek-web] turn 入口 session=${request.sessionId} initialize=${String(request.initialize)} conversationStarted=${String(this.conversationStarted)}`,
    )

    if (request.initialize && !this.conversationStarted) {
      await this.startFreshConversation(page)
      this.conversationStarted = true
    }

    // 频控自动重发：网页提示“发送过于频繁”时等待后重发同一条消息，
    // 而不是中断回合报错；重试用尽才抛 WEB_RATE_LIMITED。
    const rateLimit = this.options.config.rateLimit
    const maxRetries = rateLimit?.enabled === false ? 0 : rateLimit?.maxRetries ?? 5
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.sendAndWait(page, request)
      if (outcome.kind === 'completed') {
        const parsed = parseCompletionBody(outcome.completion.body)
        if (!parsed.text && !parsed.reasoning && parsed.contextLengthExceeded !== true) {
          throw new LlmError(
            `deepseek-web: 网页响应没有可解析正文（HTTP ${outcome.completion.status}，${outcome.completion.url}）`,
            'WEB_EMPTY_RESPONSE',
          )
        }
        return {
          text: parsed.text,
          ...parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {},
          ...parsed.accumulatedUsage !== undefined ? { accumulatedUsage: parsed.accumulatedUsage } : {},
          ...parsed.contextLengthExceeded === true ? { contextLengthExceeded: true } : {},
        }
      }
      if (attempt >= maxRetries) {
        throw new LlmError(
          `deepseek-web: 网页提示发送过于频繁，已自动重发 ${maxRetries} 次仍未成功。`
          + '请稍后在网页端手动发送，或稍后重试本任务。',
          'WEB_RATE_LIMITED',
        )
      }
      const delayMs = rateLimit?.retryDelayMs ?? 30_000
      console.info(
        `[deepseek-web] 网页提示发送频繁，${Math.round(delayMs / 1000)}s 后自动重发同一条消息（第 ${attempt + 1}/${maxRetries} 次）…`,
      )
      await this.markPageStatus(page, `[dsh 频控：${Math.round(delayMs / 1000)}s 后自动重发]`)
      await this.sleep(delayMs, request.signal)
      await this.markPageStatus(page, undefined).catch(() => {})
    }
  }

  /**
   * 一轮“填入 → 发送 → 等回复”。检测到频控（toast / 429 / 响应体提示）时
   * 返回 rate-limited，由 turn() 的重发循环接手；其余情况返回完整响应。
   * 同时把网页端的流式增量经 onProgress 回调上抛（实时思考流）。
   */
  private async sendAndWait(
    page: Page,
    request: BrowserTurnRequest,
  ): Promise<
    { kind: 'completed'; completion: ChatCompletionResponse } | { kind: 'rate-limited' }
  > {
    const autoSend = request.autoSend
      ?? this.autoSendSessions.get(request.sessionId)
      ?? this.options.config.sendMode === 'approved'

    // 提前挂监听，防止用户在我们填完后立刻点击发送导致漏掉响应。
    // 频控重发时旧 waiter 用 waiterActive 作废，避免迟到响应串扰下一轮。
    let waiterActive = true
    const waiter = page.waitForResponse(async response => {
      if (response.request().method() !== 'POST') return false
      if (!matchesCompletionUrl(response.url())) return false
      return true
    }, { timeout: this.options.config.streamIdleTimeoutMs }).then(async response => {
      await this.markPageStatus(page, '[dsh 网页生成中]').catch(() => {})
      await response.finished().catch(() => {})
      const body = await response.body().catch(() => '')
      if (!waiterActive) return undefined
      return {
        url: response.url(),
        request: {
          postData: response.request().postData()?.slice(0, 4_000),
        },
        status: response.status(),
        body: body.toString(),
      } satisfies ChatCompletionResponse
    }, (error) => {
      if (!waiterActive) return undefined
      throw error
    })

    let rateLimitedNow: (() => void) | undefined
    const rateLimited = new Promise<{ kind: 'rate-limited' }>(resolve => {
      rateLimitedNow = () => resolve({ kind: 'rate-limited' })
    })

    const editor = locateEditor(page)
    if (!(await editor.isVisible().catch(() => false))) {
      // 轮换/导航后 SPA 渲染可能滞后：先等输入框出现（最多 15 秒），仍没有再报错
      const appeared = await editor.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
      if (!appeared) {
        waiterActive = false
        if (await looksLoggedOut(page)) {
          throw new LlmError(
            'deepseek-web: 浏览器窗口已打开，但 chat.deepseek.com 尚未登录。'
            + '请在窗口中完成登录后重试本轮任务（登录状态会保存在本地 profile）。',
            'WEB_LOGIN_REQUIRED',
          )
        }
        throw new LlmError(
          'deepseek-web: 未找到聊天输入框。请确认浏览器停留在 chat.deepseek.com 的对话页；'
          + '若刚切换过页面请稍等片刻后重试。',
          'WEB_EDITOR_NOT_FOUND',
        )
      }
    }

    // 实时思考流：确保页面里的网络镜像已就位（幂等），发送后轮询增量
    const progressTimer = request.onProgress
      ? await this.startProgressPolling(page, request)
      : undefined
    const toastTimer = setInterval(() => {
      void hasRateLimitToast(page).then(hit => {
        if (hit) rateLimitedNow?.()
      })
    }, POLL_INTERVAL_MS)

    await editor.click()
    // 清掉可能残留的内容
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(request.text)
    this.conversationStarted = true
    if (autoSend) {
      // 全自动：输入框已聚焦（editor.click），模拟回车发送；不动窗口焦点，dsh 全程在前
      await editor.focus()
      await page.keyboard.press('Enter')
      await this.markPageStatus(page, '[dsh 自动发送中]')
      console.info('[deepseek-web] 全自动：已输入并回车发送…')
    } else {
      // 半自动：网页窗口置顶到屏幕最上方并聚焦输入框，用户直接回车或点击发送
      await page.bringToFront()
      await this.focusBrowser()
      const focus = this.options.config.focus
      if (focus?.enabled !== false && focus?.webWindow !== false) {
        await setBrowserWindowTopmost({ profileDir: this.profileDir, topmost: true }).catch(() => {})
      }
      await editor.focus()
      await this.markPageStatus(page, '[dsh 等待你在网页点击发送]')
      console.info('[deepseek-web] 消息已填入 Edge 并置顶聚焦，请回车或点击“发送”…')
    }

    try {
      const winner = await Promise.race([waiter, rateLimited])
      // 作废 waiter 的 undefined 不会先于 race 落定；防御性兜底按频控处理
      if (winner === undefined) return { kind: 'rate-limited' }
      if ('kind' in winner) return winner
      if (winner.status === 429 || looksLikeRateLimitText(winner.body.slice(0, 2_000))) {
        console.warn(`[deepseek-web] 响应判定为频控（HTTP ${winner.status}）。`)
        return { kind: 'rate-limited' }
      }
      console.info('[deepseek-web] 已收到网页完整回复，正在解析…')
      return { kind: 'completed', completion: winner }
    } catch (error) {
      if (page.isClosed()) {
        throw new LlmError('deepseek-web: 浏览器页面被关闭', 'WEB_PAGE_CLOSED')
      }
      // 超时兜底：toast 可能出现在两次轮询之间又已消失，最后确认一次
      if (await hasRateLimitToast(page)) return { kind: 'rate-limited' }
      throw new LlmError(
        autoSend
          ? 'deepseek-web: 全自动发送后未收到网页响应。可能回车未触发发送（输入框为空或页面结构变化），请人工检查网页后重试。'
          : 'deepseek-web: 已把消息填入浏览器，等待你点击“发送”超时。请确认输入框内容后点击页面上的发送按钮重试。',
        autoSend ? 'WEB_AUTO_SEND_TIMEOUT' : 'WEB_MANUAL_SEND_TIMEOUT',
      )
    } finally {
      waiterActive = false
      clearInterval(toastTimer)
      if (progressTimer) clearInterval(progressTimer)
      await this.markPageStatus(page, undefined).catch(() => {})
    }
  }

  /** 可中断的等待（AbortSignal 触发时抛 WEB_TURN_ABORTED）。 */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const step = 200
    for (let waited = 0; waited < ms; waited += step) {
      if (signal?.aborted) {
        throw new LlmError('deepseek-web: 等待频控重发期间回合被取消。', 'WEB_TURN_ABORTED')
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(step, ms - waited)))
    }
  }

  /**
   * 注入页面网络镜像（fetch + XHR）：把匹配 chat/completion 的 POST 响应体
   * 累积到 window.__dshWebCapture，供实时思考流轮询。幂等，页面导航后重装。
   */
  private async ensureCapture(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as typeof window & {
        __dshWebCapture?: { entries: Array<{ at: number; body: string; done: boolean }> }
      }
      if (w.__dshWebCapture) {
        w.__dshWebCapture.entries = w.__dshWebCapture.entries.slice(-20)
        return
      }
      const state: { entries: Array<{ at: number; body: string; done: boolean }> } = { entries: [] }
      w.__dshWebCapture = state
      const matches = (url: string, method?: string): boolean => {
        if (method !== undefined && method.toUpperCase() !== 'POST') return false
        return /\/chat\/completion/i.test(url)
      }
      const keep = (entry: { at: number; body: string; done: boolean }): void => {
        state.entries.push(entry)
        if (state.entries.length > 20) state.entries.splice(0, state.entries.length - 20)
      }
      const originalFetch = w.fetch.bind(w)
      w.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
        const method = init?.method ?? (input instanceof Request ? input.method : undefined)
        if (!matches(String(url), method)) return originalFetch(input, init)
        const entry = { at: Date.now(), body: '', done: false }
        keep(entry)
        try {
          const response = await originalFetch(input, init)
          // 增量读取克隆流：正文随 SSE 逐块累积，页面侧照常消费原始流
          const reader = response.clone().body?.getReader()
          if (reader) {
            const decoder = new TextDecoder()
            void (async () => {
              for (;;) {
                const { done, value } = await reader.read()
                if (value) entry.body += decoder.decode(value, { stream: true })
                if (done) break
              }
              entry.done = true
            })().catch(() => { entry.done = true })
          } else {
            entry.done = true
          }
          return response
        } catch (error) {
          entry.done = true
          throw error
        }
      }
      const originalOpen = XMLHttpRequest.prototype.open
      const originalSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function (
        this: XMLHttpRequest & { __dshUrl?: string; __dshMethod?: string },
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) {
        this.__dshUrl = String(url)
        this.__dshMethod = String(method)
        return originalOpen.apply(this, [method, url, ...rest] as Parameters<typeof originalOpen>)
      } as typeof XMLHttpRequest.prototype.open
      XMLHttpRequest.prototype.send = function (
        this: XMLHttpRequest & { __dshUrl?: string; __dshMethod?: string },
        ...args: unknown[]
      ) {
        if (matches(this.__dshUrl ?? '', this.__dshMethod)) {
          const entry = { at: Date.now(), body: '', done: false }
          keep(entry)
          this.addEventListener('progress', () => {
            try { entry.body = this.responseText ?? '' } catch { /* responseText 不可读时忽略 */ }
          })
          this.addEventListener('loadend', () => { entry.done = true })
        }
        return originalSend.apply(this, args as Parameters<typeof originalSend>)
      } as typeof XMLHttpRequest.prototype.send
    }).catch(error => {
      console.warn('[deepseek-web] 实时思考流镜像注入失败（不影响最终回复）：', error instanceof Error ? error.message : error)
    })
  }

  /** 启动实时增量轮询；返回要清理的 timer（仅当 liveThinking 开启）。 */
  private async startProgressPolling(
    page: Page,
    request: BrowserTurnRequest,
  ): Promise<NodeJS.Timeout | undefined> {
    if (this.options.config.liveThinking !== true) return undefined
    await this.ensureCapture(page)
    const startedAt = Date.now() - 1_000
    const onProgress = request.onProgress
    let emittedText = ''
    let emittedReasoning = ''
    return setInterval(() => {
      void page.evaluate((since) => {
        const state = (window as typeof window & {
          __dshWebCapture?: { entries: Array<{ at: number; body: string; done: boolean }> }
        }).__dshWebCapture
        if (!state) return undefined
        const candidates = state.entries.filter(entry => entry.at >= since && entry.body.length > 0)
        const latest = candidates.at(-1)
        return latest === undefined ? undefined : { body: latest.body, done: latest.done }
      }, startedAt).then((captured) => {
        if (captured === undefined) return
        const parsed = parseCompletionBody(captured.body)
        // 门禁 1：镜像可能捕获到非对话流（状态/心跳通道）。结构化解析一无所获时
        // parseCompletionBody 会把原始响应体当 text 兜底返回——绝不能把它灌进思考流
        //（2026-09-25 事故：46KB 原始 SSE 被持久化进 reasoning 块，污染会话日志）。
        if (parsed.reliable !== true) return
        // 累计重建应当单调增长；一旦回缩（协议变化）就只对齐基线，不发负增量
        if (parsed.text.length < emittedText.length) emittedText = parsed.text
        const reasoning = parsed.reasoning ?? ''
        if (reasoning.length < emittedReasoning.length) emittedReasoning = reasoning
        const textDelta = parsed.text.length > emittedText.length ? parsed.text.slice(emittedText.length) : ''
        const reasoningDelta = reasoning.length > emittedReasoning.length ? reasoning.slice(emittedReasoning.length) : ''
        emittedText = parsed.text
        emittedReasoning = reasoning
        if (textDelta === '' && reasoningDelta === '') return
        // 门禁 2：增量里出现 SSE 原始帧特征一律丢弃（防御性，正常解析不会出现）
        if (POLLUTION_PATTERN.test(textDelta) || POLLUTION_PATTERN.test(reasoningDelta)) {
          console.warn('[deepseek-web] 实时增量里检测到原始流特征，已丢弃本批增量。')
          return
        }
        // 门禁 3：单条增量异常巨大视为不可信
        if (textDelta.length > 8_000 || reasoningDelta.length > 8_000) {
          console.warn('[deepseek-web] 实时增量异常巨大，已丢弃本批增量。')
          return
        }
        try {
          onProgress?.({ text: textDelta, reasoning: reasoningDelta })
        } catch (error) {
          console.warn('[deepseek-web] 实时思考流回调异常（已忽略）：', error instanceof Error ? error.message : error)
        }
      }).catch(() => {})
    }, POLL_INTERVAL_MS)
  }

  /** 填入消息 / 首次请求：把网页窗口提到最前（受 config.focus 开关控制）。 */
  async focusBrowser(): Promise<void> {
    const focus = this.options.config.focus
    if (focus?.enabled === false || focus?.webWindow === false) return
    if (!this.page || this.page.isClosed()) return
    await this.page.bringToFront().catch(() => {})
  }

  /** 回合（含审核）结束、正文交给 Harness：把 dsh 宿主窗口提到最前。 */
  async focusHarness(): Promise<void> {
    const focus = this.options.config.focus
    if (focus?.enabled === false || focus?.dshWindow === false) return
    await focusDshWindow({
      processNames: focus?.dshProcessNames,
      titlePattern: focus?.dshTitlePattern,
    }).catch(() => {})
  }

  private readonly autoSendSessions = new Map<string, boolean>()

  /** 记录会话的发送方式：全自动会话的后续轮次与自审轮次都自动发送。 */
  setSessionAutoSend(sessionId: string, auto: boolean): void {
    this.autoSendSessions.set(sessionId, auto)
  }

  /** 置顶/取消置顶插件专用的 Edge 窗口（按 profile 目录定位）。 */
  async setWebWindowTopmost(_sessionId: string, topmost: boolean): Promise<void> {
    const focus = this.options.config.focus
    if (focus?.enabled === false || focus?.webWindow === false) return
    await setBrowserWindowTopmost({ profileDir: this.profileDir, topmost }).catch(() => {})
  }

  async status(): Promise<{ ready: boolean; url?: string; message?: string }> {
    if (!this.browser || !this.page) {
      return { ready: false, message: '浏览器尚未启动' }
    }
    const modelLabel = WEB_MODEL_CAPABILITIES[this.options.config.model as WebModelId]?.label
    return {
      ready: !this.page.isClosed(),
      url: this.page.url(),
      message: `浏览器已连接${modelLabel ? `，目标模型：${modelLabel}` : ''}`,
    }
  }

  async dispose(): Promise<void> {
    if (this.options.config.browser === 'attach') return
    const managed = this.managedConnection
    this.managedConnection = undefined
    await managed?.browser.close().catch(() => {})
    // browser.close() normally terminates the real browser. The launcher handle
    // is kept as a fallback for startup failures or browsers that ignore CDP close.
    if (managed?.process && !managed.process.killed) managed.process.kill()
    this.browser = undefined
    this.context = undefined
    this.page = undefined
    this.conversationStarted = false
  }
}
