/**
 * 对话视图空白自愈（v4：适配 dsh 0.2 的会话选择模型）。
 *
 * Web UI 的一个冷启动竞态：会话绑定物化时会激活 chat 视图目标，但若那一刻
 * `conversation.view` 槽位（由 ui-chat 注册）尚未就绪，激活被静默跳过；
 * 于是冷打开（恢复上次会话）时对话窗格可能永久空白，而会话数据其实已完整加载。
 *
 * v3 依赖 `ctx.sessions.list.getSnapshot().current` 判断“当前会话”。dsh 0.2
 * 移除了该字段——`SessionListState` 现在只有 ids / byId / phase / projectionsBySession，
 * 注释明确写着 “view selection remains outside the Controller”。因此本版改为：
 *
 * - 对**已持有 Session binding 的会话**订阅事件源；历史回填落地时会触发自检，
 *   这本来就是 v3 里最可靠的判定点，也是冷打开时的实际触发路径；
 * - 自检对每个会话幂等：`ctx.uiConversation.binding()` 对非活动会话会抛错，
 *   而 `conversationOf()` 已吞掉该异常并返回 undefined，因此非活动会话自动空转，
 *   不会误激活别的会话；
 * - 会话列表变化时重新对齐订阅集合，并补一次首检，覆盖“绑定晚于事件到达”的时序。
 *
 * 修复动作本身与 v3 相同：补一次
 * `uiConversation.binding(id).activate('chat')`（幂等，等价于用户手动切换视图），
 * 2 秒后仍未渲染再补一次 rebuild() + flush()。不自动刷新页面。
 *
 * @module dsh-deepseek-web/client/conversation-recovery
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型-only：拉起 ctx.sessions / ctx.uiConversation 的声明合并。
// client bundle 纯度门禁禁止值导入，服务一律通过 inject 注入。
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 控制器侧的品牌化 SessionId；经 ISessions 方法签名提取，避免再引依赖。 */
type SessionIdLike = Parameters<ISessions['binding']>[0]

/** 会话列表变化后第一次自检的延迟。 */
const FIRST_CHECK_MS = 600
/** 事件落地后自检的延迟。 */
const FEED_CHECK_MS = 400
/** 激活后复查的延迟。 */
const RETRY_CHECK_MS = 2_000

/** chat 视图快照里判断空白所需的最小形状（避免值导入 ui-chat 契约）。 */
interface ChatSnapshotLike {
  readonly order?: readonly string[]
}

interface ConversationBindingLike {
  readonly snapshot: {
    getSnapshot(): { views: { get(key: string): unknown } }
  }
  /** 激活一个视图目标（幂等）；与手动切换视图等效。 */
  activate(target: string): void
  rebuild(): void
  /** 同步把待构建的视图快照落地并发布（上游 publication 链可能漏发 flush）。 */
  flush(): void
}

export function monitorConversationBlank(ctx: ClientContext): void {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** sessionId → 事件源退订函数；只为当前持有 binding 的会话建立。 */
  const watched = new Map<SessionIdLike, () => void>()

  const conversationOf = (sessionId: SessionIdLike): ConversationBindingLike | undefined => {
    try {
      return ctx.uiConversation.binding(sessionId) as unknown as ConversationBindingLike
    } catch {
      // 非活动会话会抛错：这里正是“只对当前显示的会话生效”的判定点
      return undefined
    }
  }

  const schedule = (fn: () => void, delay: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, delay)
    timers.add(timer)
  }

  /** chat 视图快照；undefined = 目标从未构建。 */
  const chatSnapshotOf = (sessionId: SessionIdLike): ChatSnapshotLike | undefined => {
    const conversation = conversationOf(sessionId)
    if (conversation === undefined) return undefined
    try {
      return conversation.snapshot.getSnapshot().views.get('chat') as ChatSnapshotLike | undefined
    } catch {
      return undefined
    }
  }

  const isRendered = (sessionId: SessionIdLike): boolean => {
    const chat = chatSnapshotOf(sessionId)
    return chat !== undefined && (chat.order?.length ?? 0) > 0
  }

  /**
   * 核心自愈：会话确有内容、不是从未使用的空会话、而 chat 视图未渲染时，
   * 补激活 chat 目标；激活后仍未渲染（快照构建了但内容为空）再 rebuild 一次。
   * activate 幂等：视图已正常时是无害空操作；非活动会话在建 binding 前就返回。
   */
  const ensureRendered = (sessionId: SessionIdLike): void => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      if (binding.eventSource.getSnapshot().entries.length === 0) return // 无内容，谈不上渲染问题
      if (binding.session.getSnapshot().blank === true) return // 从未使用的空会话本来就空
      if (isRendered(sessionId)) return
      const conversation = conversationOf(sessionId)
      if (conversation === undefined) return
      // 1) 补激活 chat 目标（幂等；等价于用户手动切换视图）
      conversation.activate('chat')
      // 2) 强制同步 flush：上游 publication 链在“激活晚于事件到达”的时序下
      //    可能不再触发 flush（replacePending/dirty 滞留），这里直接落地快照
      try {
        conversation.flush()
      } catch (error) {
        console.warn('[deepseek-web] 强制 flush 失败：', error)
      }
      // 3) 复查；仍未渲染（快照构建了但内容为空）再 rebuild + flush 一次
      schedule(() => {
        if (isRendered(sessionId)) return
        console.info('[deepseek-web] 激活后仍未渲染，重建对话视图快照…')
        try {
          conversation.rebuild()
          conversation.flush()
        } catch (error) {
          console.warn('[deepseek-web] 重建失败：', error)
        }
      }, RETRY_CHECK_MS)
    } catch (error) {
      console.warn('[deepseek-web] 对话视图自检失败：', error)
    }
  }

  /**
   * 把订阅集合对齐到“列表里可见且已持有 Session binding”的会话：
   * 新增订阅，消失的退订。没有当前会话信号，就用“有 binding”近似“可能正在显示”。
   */
  const syncWatches = (): void => {
    const ids = new Set<SessionIdLike>(ctx.sessions.list.getSnapshot().ids)
    for (const [sessionId, unsubscribe] of [...watched]) {
      if (ids.has(sessionId)) continue
      unsubscribe()
      watched.delete(sessionId)
    }
    for (const sessionId of ids) {
      if (watched.has(sessionId)) continue
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) continue
      watched.set(sessionId, binding.eventSource.subscribe(() => {
        // 历史回填落地是最可靠的判定点
        schedule(() => ensureRendered(sessionId), FEED_CHECK_MS)
      }))
    }
  }

  ctx.effect(() => {
    const listUnsubscribe = ctx.sessions.list.subscribe(() => {
      syncWatches()
      // 绑定可能晚于事件到达：对齐后对每个已订阅会话补一次首检
      for (const sessionId of [...watched.keys()]) {
        schedule(() => ensureRendered(sessionId), FIRST_CHECK_MS)
      }
    })
    syncWatches()
    for (const sessionId of [...watched.keys()]) {
      schedule(() => ensureRendered(sessionId), FIRST_CHECK_MS)
    }
    return () => {
      listUnsubscribe()
      for (const unsubscribe of watched.values()) unsubscribe()
      watched.clear()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, 'dsh-deepseek-web: conversation blank recovery')
}
