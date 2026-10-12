/**
 * GLM（chat.z.ai）网页版浏览器通道：结构与 Kimi/DeepSeek 通道一致
 * （常驻 Edge + 人工点击发送），差异在响应协议（SSE + chat:completion）。
 *
 * 签名（X-Signature / X-FE-Version）由页面自身在发请求时生成，
 * 本通道只负责把消息填入输入框、等待响应、解析正文，不自行构造 HTTP 请求。
 *
 * @module dsh-deepseek-web/glm-channel
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  bestEffortNewChat,
  connectBrowser,
  defaultProfileDir,
  ensureChatPage,
  locateEditor,
  focusDshWindow,
  looksLoginWall,
  looksSendBlocked,
  markPageTitle,
  type TitleMarkerState,
} from './browser-shared.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from './browser-channel.ts'
import type { ReviewConfig } from './config.ts'

export interface GlmChannelOptions {
  config: ReviewConfig
  /** 主配置的窗口聚焦策略；GLM 通道用于审核结束后把 dsh 窗口提到最前。 */
  focus?: {
    enabled: boolean
    webWindow: boolean
    dshWindow: boolean
    dshProcessNames: string[]
    dshTitlePattern: string
  }
  profileDir?: string
  label?: string
}

/** GLM 对话接口（SSE，`text/event-stream`）。 */
export function matchesGlmCompletion(url: string): boolean {
  return /chat\/completions/i.test(url)
}

/**
 * 解析 GLM SSE 流。
 *
 * 事件形态（2026-09 真实样本，`calibration/glm-chat-*.bin`）：
 * - `{"phase":"thinking","delta_content":"…"}` 思考过程 —— **不是正文**，单独归到 reasoning
 * - `{"phase":"answer","delta_content":"…"}` 增量正文
 * - `{"phase":"other","usage":{…}}` 用量统计等非正文事件
 * - `{"phase":"done","done":true}` 结束
 * - `data: [DONE]` 流结束哨兵
 *
 * 注意：thinking 与 answer 用的是同一个 `delta_content` 字段，只有 `phase` 能区分。
 * 早期版本把两者一律并入正文，导致思考过程混进交付文本（会污染审核输入与结论展示）。
 */
export function parseGlmCompletion(input: Buffer | string): { text: string; reasoning?: string } {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  const raw = buffer.toString('utf8')
  let text = ''
  let reasoning = ''
  let sawAny = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let event: {
      type?: string
      data?: { delta_content?: string; delta_reasoning?: string; phase?: string }
    }
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    sawAny = true
    if (event.type === 'chat:completion') {
      const phase = typeof event.data?.phase === 'string' ? event.data.phase : ''
      const content = typeof event.data?.delta_content === 'string' ? event.data.delta_content : ''
      const deltaReasoning = typeof event.data?.delta_reasoning === 'string' ? event.data.delta_reasoning : ''
      if (deltaReasoning) reasoning += deltaReasoning
      if (content) {
        // phase=thinking 走 reasoning；phase=answer 才是正文；
        // 没有 phase 字段的历史样本按正文处理，保持兼容。
        if (phase === 'thinking') reasoning += content
        else if (phase === 'answer' || phase === '') text += content
      }
    }
  }
  if (!text && !reasoning && sawAny) {
    return { text: '' }
  }
  if (!text && !reasoning) {
    // 落盘原始样本，便于继续校准
    const dir = path.join(process.env.LOCALAPPDATA ?? '', 'DshDeepSeekWeb', 'calibration')
    const file = path.join(dir, `glm-unparsed-${Date.now()}.bin`)
    void import('node:fs/promises')
      .then(fs => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer)))
      .catch(() => {})
    throw new LlmError('glm: SSE 流里没有解析出正文', 'GLM_EMPTY_RESPONSE')
  }
  return { text, ...reasoning ? { reasoning } : {} }
}

export class GLMChannel implements BrowserChannel {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  private conversationStarted = false
  private readonly titleState: TitleMarkerState = {}
  private readonly options: GlmChannelOptions
  private readonly profileDir: string
  private readonly label: string

  constructor(options: GlmChannelOptions) {
    this.options = options
    this.profileDir = options.profileDir ?? options.config.glmProfileDir ?? defaultProfileDir('glm-profile')
    this.label = options.label ?? 'glm'
  }

  async ensureReady(): Promise<void> {
    if (this.browser && this.page) return
    const { browser, context } = await connectBrowser({
      port: this.options.config.glmDebugPort,
      profileDir: this.profileDir,
      url: this.options.config.glmUrl,
      autoStartKeeper: true,
      label: this.label,
    })
    this.browser = browser
    this.context = context
    const pages = context.pages()
    this.page = pages.find(item => item.url().startsWith(new URL(this.options.config.glmUrl).origin))
      ?? pages[0]
      ?? await context.newPage()
    await ensureChatPage(this.page, this.options.config.glmUrl)
    await this.page.waitForTimeout(1_500)
    if (await looksLoginWall(this.page)) {
      throw new LlmError(
        'glm: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。'
        + '请先运行 node tools/open-login-glm.mjs 完成一次登录，再重试审核。',
        'GLM_LOGIN_REQUIRED',
      )
    }
  }

  resetConversationGate(): void {
    this.conversationStarted = false
  }

  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    if (!this.page) await this.ensureReady()
    const page = this.page!

    if (request.initialize && !this.conversationStarted) {
      await bestEffortNewChat(page)
      await page.waitForTimeout(800)
      this.conversationStarted = true
    }

    const completionPromise = page.waitForResponse(
      response => response.request().method() === 'POST' && matchesGlmCompletion(response.url()),
      { timeout: this.options.config.streamIdleTimeoutMs },
    ).then(async response => {
      await markPageTitle(page, '[dsh GLM 审核生成中]', this.titleState)
      await response.finished().catch(() => {})
      return {
        url: response.url(),
        status: response.status(),
        body: await response.body().catch(() => Buffer.alloc(0)),
      }
    })

    const editor = locateEditor(page)
    if (!(await editor.isVisible().catch(() => false))) {
      throw new LlmError('glm: 未找到对话输入框。请确认浏览器停留在 chat.z.ai 的对话页。', 'GLM_EDITOR_NOT_FOUND')
    }
    await editor.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(request.text)
    // 未登录的 chat.z.ai 允许填字但发送按钮 disabled：立刻报明确原因，不空等超时。
    // 先给页面一点时间把按钮置为可用，避免刚填完就抢跑产生误判。
    let sendBlocked = await looksSendBlocked(page)
    if (sendBlocked) {
      await page.waitForTimeout(600)
      sendBlocked = await looksSendBlocked(page)
    }
    if (sendBlocked) {
      throw new LlmError(
        'glm: 发送按钮不可用，消息发不出去——通常是尚未登录 chat.z.ai。'
        + '请先运行 node tools/open-login-glm.mjs 登录；'
        + '若已登录请确认页面没有正在生成的回复。',
        'GLM_SEND_BLOCKED',
      )
    }

    if (request.autoSend) {
      await markPageTitle(page, '[dsh 自动发送中]', this.titleState)
      await page.keyboard.press('Enter')
      console.info('[glm] 全自动：已输入并回车发送…')
    } else {
      await page.bringToFront()
      this.conversationStarted = true
      await markPageTitle(page, '[dsh 等待你在 GLM 点击发送]', this.titleState)
      console.info('[glm] 消息已填入 Edge，请在 GLM 页面点击“发送”…')
    }

    let completion: { url: string; status: number; body: Buffer }
    try {
      completion = await completionPromise
      console.info('[glm] 已收到 GLM 完整回复，正在解析…')
    } catch (error) {
      if (page.isClosed()) throw new LlmError('glm: 浏览器页面被关闭', 'GLM_PAGE_CLOSED')
      throw new LlmError(
        request.autoSend
          ? 'glm: 全自动发送后未收到网页响应。可能回车未触发发送（输入框为空或页面结构变化），请人工检查网页后重试。'
          : 'glm: 已把消息填入浏览器，等待你点击“发送”超时。请点击发送后重试。',
        request.autoSend ? 'GLM_AUTO_SEND_TIMEOUT' : 'GLM_MANUAL_SEND_TIMEOUT',
        { cause: error },
      )
    } finally {
      await markPageTitle(page, undefined, this.titleState)
    }

    return parseGlmCompletion(completion.body)
  }

  /** 填入消息：把 GLM 窗口提到最前（受注入的 focus 开关控制）。 */
  async focusBrowser(): Promise<void> {
    const focus = this.options.focus
    if (focus && (focus.enabled === false || focus.webWindow === false)) return
    if (!this.page || this.page.isClosed()) return
    await this.page.bringToFront().catch(() => {})
  }

  /**
   * 仅用于满足 BrowserChannel 接口的一致性占位：
   * 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发。
   */
  async focusHarness(): Promise<void> {
    const focus = this.options.focus
    if (!focus || focus.enabled === false || focus.dshWindow === false) return
    await focusDshWindow({
      processNames: focus.dshProcessNames,
      titlePattern: focus.dshTitlePattern,
    }).catch(() => {})
  }

  async status(): Promise<{ ready: boolean; url?: string; message?: string }> {
    if (!this.browser || !this.page) return { ready: false, message: 'GLM 浏览器尚未启动' }
    return { ready: !this.page.isClosed(), url: this.page.url(), message: 'GLM 审核通道已连接' }
  }

  async dispose(): Promise<void> {
    // 浏览器由常驻守护拥有，这里只释放引用，不关闭窗口。
    this.browser = undefined
    this.context = undefined
    this.page = undefined
  }
}
