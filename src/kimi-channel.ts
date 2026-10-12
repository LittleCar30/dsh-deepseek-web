/**
 * Kimi 网页版浏览器通道：结构与 DeepSeek 通道一致（常驻 Edge + 人工点击发送），
 * 差异在响应协议（Connect-RPC / op / mask），需要抓包校准后实现解析。
 *
 * @module dsh-deepseek-web/kimi-channel
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { gunzipSync } from 'node:zlib'
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

export interface KimiChannelOptions {
  config: ReviewConfig
  /** 主配置的窗口聚焦策略；Kimi 通道用于审核结束后把 dsh 窗口提到最前。 */
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

/** Kimi 对话接口（Connect-RPC，`application/connect+json`）。 */
function matchesKimiCompletion(url: string): boolean {
  return /ChatService\/Chat/i.test(url)
}

/**
 * 解析 Kimi Connect-RPC 流：5 字节帧头（1 字节 flags + 4 字节大端长度）+ JSON 载荷。
 *
 * 事件形态（实测样本）：
 * - `{"op":"set","mask":"block.text","block":{"id","text":{"content"}}}` 建立正文块
 * - `{"op":"append","mask":"block.text.content","block":{"id","text":{"content"}}}` 追加正文
 * - `block.think` / `block.think.content` 同理，属于思考内容
 * - `{"op":"set","mask":"message.status","message":{"status":"MESSAGE_STATUS_COMPLETED"}}` 结束
 * - flags=2 的帧是 Connect 的 end-of-stream 哨兵
 */
export function parseKimiCompletion(input: Buffer | string): { text: string; reasoning?: string } {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'binary')
  const textBlocks = new Map<string, string>()
  const thinkBlocks = new Map<string, string>()
  const textOrder: string[] = []
  const thinkOrder: string[] = []

  const upsert = (
    store: Map<string, string>,
    order: string[],
    id: string,
    content: string,
    append: boolean,
  ): void => {
    if (!store.has(id)) order.push(id)
    store.set(id, append ? `${store.get(id) ?? ''}${content}` : content)
  }

  let offset = 0
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset]!
    const length = buffer.readUInt32BE(offset + 1)
    if (offset + 5 + length > buffer.length) break
    let payload = buffer.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length
    if ((flags & 0b10) !== 0) break
    if ((flags & 0b01) !== 0) {
      // Connect 压缩帧：payload 为 gzip 压缩的 JSON；解不出来就保持原样。
      try {
        payload = gunzipSync(payload)
      } catch {
        // 保持原样，交给 JSON 解析失败路径处理
      }
    }

    let event: {
      op?: string
      mask?: string
      message?: { role?: string; status?: string; blocks?: unknown[] }
      block?: {
        id?: string
        text?: { content?: string }
        think?: { content?: string }
      }
    }
    try {
      event = JSON.parse(payload.toString('utf8'))
    } catch {
      continue
    }

    const append = event.op === 'append'
    const mask = event.mask ?? ''
    const blockId = event.block?.id ?? mask
    if (mask.startsWith('block.text')) {
      const content = event.block?.text?.content
      if (typeof content === 'string') upsert(textBlocks, textOrder, blockId, content, append)
    } else if (mask.startsWith('block.think')) {
      const content = event.block?.think?.content
      if (typeof content === 'string') upsert(thinkBlocks, thinkOrder, blockId, content, append)
    } else if (
      mask === 'message'
      && event.message?.role === 'assistant'
      && Array.isArray(event.message.blocks)
    ) {
      for (const raw of event.message.blocks) {
        const block = raw as {
          id?: string
          text?: { content?: string }
          think?: { content?: string }
        }
        const id = block.id ?? `${textOrder.length}`
        if (typeof block.text?.content === 'string') upsert(textBlocks, textOrder, id, block.text.content, false)
        if (typeof block.think?.content === 'string') upsert(thinkBlocks, thinkOrder, id, block.think.content, false)
      }
    }
  }

  const collect = (store: Map<string, string>, order: string[]): string =>
    order.map(id => store.get(id) ?? '').join('').trim()

  const text = collect(textBlocks, textOrder)
  const reasoning = collect(thinkBlocks, thinkOrder)
  if (!text && !reasoning) {
    // 落盘原始样本，便于继续校准
    const dir = path.join(process.env.LOCALAPPDATA ?? '', 'DshDeepSeekWeb', 'calibration')
    const file = path.join(dir, `kimi-unparsed-${Date.now()}.bin`)
    void import('node:fs/promises')
      .then(fs => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, buffer)))
      .catch(() => {})
    throw new LlmError('kimi: Connect-RPC 流里没有解析出正文', 'KIMI_EMPTY_RESPONSE')
  }
  return { text, ...reasoning ? { reasoning } : {} }
}

export class KimiBrowserChannel implements BrowserChannel {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  private conversationStarted = false
  private readonly titleState: TitleMarkerState = {}
  private readonly options: KimiChannelOptions
  private readonly profileDir: string
  private readonly label: string

  constructor(options: KimiChannelOptions) {
    this.options = options
    this.profileDir = options.profileDir ?? options.config.profileDir ?? defaultProfileDir('kimi-profile')
    this.label = options.label ?? 'kimi'
  }

  async ensureReady(): Promise<void> {
    if (this.browser && this.page) return
    const { browser, context } = await connectBrowser({
      port: this.options.config.debugPort,
      profileDir: this.profileDir,
      url: this.options.config.url,
      autoStartKeeper: true,
      label: this.label,
    })
    this.browser = browser
    this.context = context
    const pages = context.pages()
    this.page = pages.find(item => item.url().startsWith(new URL(this.options.config.url).origin))
      ?? pages[0]
      ?? await context.newPage()
    await ensureChatPage(this.page, this.options.config.url)
    await this.page.waitForTimeout(1_500)
    if (await looksLoginWall(this.page)) {
      throw new LlmError(
        'kimi: 浏览器窗口已打开，但尚未登录（发送按钮处于禁用状态）。'
        + '请先运行 node tools/open-login-kimi.mjs 完成一次登录。',
        'KIMI_LOGIN_REQUIRED',
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
      response => response.request().method() === 'POST' && matchesKimiCompletion(response.url()),
      { timeout: this.options.config.streamIdleTimeoutMs },
    ).then(async response => {
      await markPageTitle(page, '[dsh Kimi 审核生成中]', this.titleState)
      await response.finished().catch(() => {})
      return {
        url: response.url(),
        status: response.status(),
        body: await response.body().catch(() => Buffer.alloc(0)),
      }
    })

    const editor = locateEditor(page)
    if (!(await editor.isVisible().catch(() => false))) {
      throw new LlmError('kimi: 未找到对话输入框。请确认浏览器停留在 Kimi 的对话页。', 'KIMI_EDITOR_NOT_FOUND')
    }
    await editor.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(request.text)
    // 登录态失效时同样会“填得进去、发不出去”：立刻给出原因，不空等超时。
    let sendBlocked = await looksSendBlocked(page)
    if (sendBlocked) {
      await page.waitForTimeout(600)
      sendBlocked = await looksSendBlocked(page)
    }
    if (sendBlocked) {
      throw new LlmError(
        'kimi: 发送按钮不可用，消息发不出去——通常是尚未登录 www.kimi.com。'
        + '请先运行 node tools/open-login-kimi.mjs 登录；'
        + '若已登录请确认页面没有正在生成的回复。',
        'KIMI_SEND_BLOCKED',
      )
    }
    await page.bringToFront()
    this.conversationStarted = true
    await markPageTitle(page, '[dsh 等待你在 Kimi 点击发送]', this.titleState)
    console.info('[kimi] 消息已填入 Edge，请在 Kimi 页面点击“发送”…')

    let completion: { url: string; status: number; body: Buffer }
    try {
      completion = await completionPromise
      console.info('[kimi] 已收到 Kimi 完整回复，正在解析…')
    } catch (error) {
      if (page.isClosed()) throw new LlmError('kimi: 浏览器页面被关闭', 'KIMI_PAGE_CLOSED')
      throw new LlmError(
        'kimi: 已把消息填入浏览器，等待你点击“发送”超时。请点击发送后重试。',
        'KIMI_MANUAL_SEND_TIMEOUT',
        { cause: error },
      )
    } finally {
      await markPageTitle(page, undefined, this.titleState)
    }

    return parseKimiCompletion(completion.body)
  }

  /** 填入消息：把 Kimi 窗口提到最前（受注入的 focus 开关控制）。 */
  async focusBrowser(): Promise<void> {
    const focus = this.options.focus
    if (focus && (focus.enabled === false || focus.webWindow === false)) return
    if (!this.page || this.page.isClosed()) return
    await this.page.bringToFront().catch(() => {})
  }

  /**
   * 仅用于满足 BrowserChannel 接口的一致性占位：
   * 实际“审核完全结束后聚焦 dsh 窗口”由主通道 adapter 在最终正文交付前统一触发，
   * 本方法当前没有调用点，保留是为了让两条通道实现同一接口时不出现方法缺失。
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
    if (!this.browser || !this.page) return { ready: false, message: 'Kimi 浏览器尚未启动' }
    return { ready: !this.page.isClosed(), url: this.page.url(), message: 'Kimi 审核通道已连接' }
  }

  async dispose(): Promise<void> {
    // 浏览器由常驻守护拥有，这里只释放引用，不关闭窗口。
    this.browser = undefined
    this.context = undefined
    this.page = undefined
  }
}
