/**
 * dsh 会话与网页端对话的映射与推进游标。
 *
 * 网页端对话是权威上下文：我们不把整段历史反复发给模型，只推进
 * “已入网页对话”的游标。assistant 回复由模型自己生成并停留在页面上，
 * 所以只要把新增的 user / tool-result 转成网页消息追加即可。
 *
 * @module dsh-deepseek-web/session-state
 */

import { dirname } from 'node:path'

export interface WebChatState {
  /** 网页端对话标题/URL 标记，用于定位页面。 */
  webChatKey?: string
  /** Harness message id 游标：已处理到哪一条。 */
  lastMessageId?: string
  /** 自协议快照注入以来的轮数。 */
  roundsSinceProtocol: number
  /** 上一次回复文本（供解析/纠错使用）。 */
  lastReply?: string
  /** 最近一次解析是否成功。 */
  lastParseOk: boolean
  /** 是否已经给该网页对话发送过初始化（协议+首个任务）。 */
  initialized: boolean
  /** 当前用户任务锚点；工具轮次也随消息重申，防止模型反问“请提供任务”。 */
  goalText?: string
  /** 已使用的审核轮数（按任务目标计）。 */
  reviewRoundsUsed: number
  /** 上一次已审核产出的签名，避免同一产出重复送审。 */
  reviewedSignature?: string
  /** 网页端最近一次上报的会话累计 token 用量（accumulated_token_usage 基线）。 */
  usageBaseline?: number
  /** 上下文同步协议版本；旧状态首次使用时从宿主历史重建。 */
  contextVersion?: number
  /** 宿主压缩检查点指纹，检查点变化时重建网页对话。 */
  checkpointSignature?: string
  /** 已发送的宿主系统指令指纹。 */
  systemSignature?: string
}

/** 通道级 token 用量总计（跨 dsh 会话持久，随 session-state.json 保存）。 */
export interface ChannelTokenTotals {
  /** 累计消耗 token 总量（网页端 accumulated_token_usage 的逐轮增量之和）。 */
  totalTokens: number
  /** 已计入统计的模型回合数。 */
  usageTurns: number
  /** 最近一次计数更新时间（ISO）。 */
  updatedAt?: string
}

export interface SessionRegistryOptions {
  /** 持久化文件路径；缺省时不落盘（仅内存）。 */
  file?: string
}

export class SessionRegistry {
  private readonly chats = new Map<string, WebChatState>()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()
  private channelTotals: ChannelTokenTotals = { totalTokens: 0, usageTurns: 0 }

  private readonly options: SessionRegistryOptions

  constructor(options: SessionRegistryOptions = {}) {
    this.options = options
  }

  /** 从磁盘加载一次；重复调用为空操作。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.options.file) return
    const { readFile } = await import('node:fs/promises')
    let raw: string
    try {
      raw = await readFile(this.options.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const rawTotals = parsed.__channel_totals__ as Partial<ChannelTokenTotals> | undefined
      if (rawTotals && typeof rawTotals === 'object') {
        this.channelTotals = {
          totalTokens: Number.isSafeInteger(rawTotals.totalTokens) ? rawTotals.totalTokens! : 0,
          usageTurns: Number.isSafeInteger(rawTotals.usageTurns) ? rawTotals.usageTurns! : 0,
          ...rawTotals.updatedAt !== undefined ? { updatedAt: rawTotals.updatedAt } : {},
        }
      }
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (sessionId === '__channel_totals__') continue
        if (value && typeof value === 'object') {
          const rawState = value as Partial<WebChatState>
          this.chats.set(sessionId, {
            roundsSinceProtocol: typeof rawState.roundsSinceProtocol === 'number'
              && Number.isSafeInteger(rawState.roundsSinceProtocol)
              ? rawState.roundsSinceProtocol
              : 0,
            lastParseOk: rawState.lastParseOk !== false,
            initialized: rawState.initialized === true,
            ...rawState.lastMessageId === undefined ? {} : { lastMessageId: rawState.lastMessageId },
            ...rawState.lastReply === undefined ? {} : { lastReply: rawState.lastReply },
            ...rawState.webChatKey === undefined ? {} : { webChatKey: rawState.webChatKey },
            ...rawState.goalText === undefined ? {} : { goalText: rawState.goalText },
            reviewRoundsUsed: typeof rawState.reviewRoundsUsed === 'number'
              && Number.isSafeInteger(rawState.reviewRoundsUsed)
              ? rawState.reviewRoundsUsed
              : 0,
            ...rawState.reviewedSignature === undefined ? {} : { reviewedSignature: rawState.reviewedSignature },
            ...rawState.usageBaseline === undefined ? {} : { usageBaseline: rawState.usageBaseline },
            ...rawState.contextVersion === undefined ? {} : { contextVersion: rawState.contextVersion },
            ...rawState.checkpointSignature === undefined ? {} : { checkpointSignature: rawState.checkpointSignature },
            ...rawState.systemSignature === undefined ? {} : { systemSignature: rawState.systemSignature },
          })
        }
      }
    } catch (error) {
      throw new Error(`deepseek-web: 会话状态文件损坏（${this.options.file}）：${String(error)}`)
    }
  }

  /** 全量写回磁盘（排队串行，临时文件 + rename）。 */
  async save(): Promise<void> {
    if (!this.options.file) return
    const snapshot = JSON.stringify({
      __channel_totals__: this.channelTotals,
      ...Object.fromEntries(this.chats),
    }, null, 2)
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const { mkdir, rename, writeFile } = await import('node:fs/promises')
      const file = this.options.file!
      const dir = dirname(file)
      if (dir) await mkdir(dir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, file)
    })
    await this.writeQueue
  }

  /**
   * 记入一次通道 token 消耗并返回最新总量（跨 dsh 会话累计）。
   * @param delta - 本轮消耗的 token 增量。
   */
  addChannelTokens(delta: number): ChannelTokenTotals {
    if (!Number.isFinite(delta) || delta <= 0) return { ...this.channelTotals }
    this.channelTotals = {
      totalTokens: this.channelTotals.totalTokens + Math.round(delta),
      usageTurns: this.channelTotals.usageTurns + 1,
      updatedAt: new Date().toISOString(),
    }
    return { ...this.channelTotals }
  }

  /** 读取通道 token 用量总计。 */
  getChannelTotals(): ChannelTokenTotals {
    return { ...this.channelTotals }
  }

  for(sessionId: string): WebChatState {
    let state = this.chats.get(sessionId)
    if (!state) {
      state = {
        roundsSinceProtocol: 0,
        lastParseOk: true,
        initialized: false,
        reviewRoundsUsed: 0,
      }
      this.chats.set(sessionId, state)
    }
    return state
  }

  /** 移除会话游标并落盘。 */
  async dispose(sessionId: string): Promise<void> {
    this.chats.delete(sessionId)
    await this.save()
  }
}
