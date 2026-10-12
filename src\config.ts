/**
 * 插件配置。字段均可通过 cordis.yml 或（后续）用户设置覆盖。
 *
 * @module dsh-deepseek-web/config
 */

import z from '@deepseek-ai/schemastery'
import { WEB_MODEL_CAPABILITIES, WEB_MODEL_IDS, type WebModelId } from './web-models.ts'

export const PROVIDER = 'deepseek-web'

export { WEB_MODEL_CAPABILITIES, WEB_MODEL_IDS }
export type { WebModelId }

/** 历史模型 id：旧会话仍可能引用，解析时映射回单一入口。 */
export const LEGACY_WEB_MODEL_IDS = [
  'deepseek-web-chat',
  'deepseek-web-reasoner',
  'deepseek-web-search',
] as const

/** 把任意历史模型 id 归一到当前唯一入口；不认识时返回 undefined。 */
export function normalizeWebModel(model: string): WebModelId | undefined {
  if ((WEB_MODEL_IDS as readonly string[]).includes(model)) return model as WebModelId
  if ((LEGACY_WEB_MODEL_IDS as readonly string[]).includes(model)) return 'deepseek-web'
  return undefined
}

/**
 * 发送模式：
 * - `manual`：驱动把消息填入输入框并聚焦浏览器窗口，由用户点击发送（默认，最稳妥）
 * - `approved`：由 Harness 审批流确认后程序化点击发送（后续实现）
 */
export type SendMode = 'manual' | 'approved'

/** 可选的审核通道配置；默认关闭，关闭时行为与只用 DeepSeek 完全一致。 */
export type ReviewProvider = 'kimi' | 'deepseek-web' | 'glm'

export interface ReviewConfig {
  /** 是否启用审核（审核器由 provider 决定）。 */
  enabled: boolean
  /**
   * 审核器：
   * - `kimi`：独立第三方审核（Kimi 窗口、独立上下文，需要人工点击发送）
   * - `glm`：独立第三方审核（chat.z.ai 窗口、独立上下文，需要人工点击发送）
   * - `deepseek-web`：在同一个 DeepSeek 对话里自审（不开新窗口、不复制文件内容，更快但独立性弱）
   */
  provider: ReviewProvider
  /** Kimi 审核网页版地址。 */
  url: string
  /** 常驻 Kimi 审核浏览器的 CDP 端口。 */
  debugPort: number
  /** Kimi 审核独立 profile 目录；留空使用 %LOCALAPPDATA%\DshDeepSeekWeb\kimi-profile。 */
  profileDir?: string
  /** 审核轮次的等待超时。 */
  streamIdleTimeoutMs: number
  /** 送入审核的代码/产物证据最大字符数。 */
  maxEvidenceChars: number
  /** 单次任务最多审核多少轮，避免来回审核停不下来。 */
  maxRounds: number
  /** GLM 审核网页版地址。 */
  glmUrl: string
  /** 常驻 GLM 审核浏览器的 CDP 端口。 */
  glmDebugPort: number
  /** GLM 审核独立 profile 目录；留空使用 %LOCALAPPDATA%\DshDeepSeekWeb\glm-profile。 */
  glmProfileDir?: string
}

export interface Config {
  /** DeepSeek 网页地址。 */
  url: string
  /**
   * 浏览器通道：
   * - `managed`：本插件启动一个带独立 profile 的 Edge/Chrome 窗口，用户在此登录
   * - `attach`：连接用户已用 `--remote-debugging-port` 启动的浏览器
   */
  browser: 'managed' | 'attach'
  /** managed 模式使用的浏览器。 */
  channel: 'msedge' | 'chrome'
  /** attach 模式的调试端口；managed 模式把它作为首选端口，冲突时自动换用空闲端口。 */
  debugPort: number
  /** attach 模式下如果 CDP 端口不可达，是否自动启动/恢复浏览器常驻守护。 */
  autoStartKeeper: boolean
  /** 会话游标持久化文件；缺省写入 %LOCALAPPDATA%\DshDeepSeekWeb\session-state.json。 */
  stateFile?: string
  /** managed 模式的独立 profile 目录；留空使用 $DSH_HOME 下的默认目录。 */
  profileDir?: string
  /** 每轮是否等待人工点击发送。 */
  sendMode: SendMode
  /**
   * 窗口聚焦策略：填入网页输入框时把网页窗口提到最前；
   * 网页对话（含审核）结束、正文交给 Harness 时把 dsh 宿主窗口提到最前。
   */
  focus: {
    /** 总开关。 */
    enabled: boolean
    /** 填入网页输入框 / 首次请求时聚焦网页窗口。 */
    webWindow: boolean
    /** 回合（含审核）结束后聚焦 dsh 窗口。 */
    dshWindow: boolean
    /** dsh 窗口候选进程名（Windows 顶层窗口匹配）。 */
    dshProcessNames: string[]
    /** dsh 窗口标题正则（可选，与进程名任一命中即可）。 */
    dshTitlePattern: string
  }
  /** 网页版模型在页面上应处于哪个开关状态（供驱动校准）。 */
  model: WebModelId
  /** 页面元素/开关的 CSS 选择器覆盖；为空时使用内置默认并允许运行期“校准”。 */
  selectors?: Record<string, string>
  /** 生成空闲超时。网页回复（含人工操作）较慢，默认 10 分钟。 */
  streamIdleTimeoutMs: number
  /**
   * 频控自动重试：网页提示“消息发送过于频繁，请稍后重试”时，
   * 等待 retryDelayMs 后自动重发同一条消息，而不是中断回合报错。
   */
  rateLimit: {
    /** 总开关。 */
    enabled: boolean
    /** 检测到频控后等待多久重发（毫秒）。 */
    retryDelayMs: number
    /** 单轮最多自动重发次数；用尽后才报错（默认 5 次 ≈ 2.5 分钟窗口）。 */
    maxRetries: number
  }
  /**
   * 实时思考流：网页版生成过程中的增量内容（思考 + 正文）作为 reasoning 块
   * 流式展示在 Harness 对话里，不再只等结束时一次性给出。
   */
  liveThinking: boolean
  /** 最大回复字节数保护。 */
  maxReplyBytes: number
  /** 多久注入一次控制协议快照（按轮数）。 */
  protocolRefreshEvery: number
  /** 是否每一轮都注入协议与工具清单（默认开，防止网页会话上下文丢失后模型退化成普通聊天）。 */
  protocolEveryRequest: boolean
  /** 免费通道暴露给网页模型的工具白名单；空数组表示不限制。 */
  toolAllowlist: string[]
  /** 免费通道不暴露给网页模型的工具名（需要独立 API key 等）；在白名单之后生效。 */
  excludeToolNames: string[]
  /** 工具目录使用精简描述（名称 + 一句用途 + 必填参数），默认开。 */
  compactToolCatalog: boolean
  /** 单个工具结果送入网页模型的最大字符数，超出按头尾截断。 */
  maxToolResultChars: number
  /** 任务锚点最大字符数，防止超长任务每轮重复灌入。 */
  maxGoalChars: number
  /** 可选审核通道（Kimi / GLM 独立审核，或 DeepSeek 同对话自审）。 */
  review: ReviewConfig
  /** 模型疑似想调工具但输出无法解析时，自动注入纠错并请求重试一次。 */
  autoCorrectMalformed: boolean
  /**
   * 网页委托工具（提示词代执行）：目录里声明给网页模型，调用不本地执行，
   * 而是转成下一轮提示词交给网页端自带能力完成（如 web_search / web_fetch）。
   */
  delegatedTools: string[]
}

/**
 * 兼容垫片：给 schema 打上 volatile 标记。
 *
 * `.volatile()` 需要 schemastery ≥ 3.18.4（`Schema.prototype.volatile` 就是
 * `extra('volatile', true)`）。当模块解析到 3.18.2（本仓库 vendored 副本、
 * 0.1.5 宿主的 node_modules）时该方法不存在，直接链式调用会在模块加载时
 * 抛 `volatile is not a function`，插件整体无法启动。这里按可用性降级：
 *
 * 1. 原生 `.volatile()`（3.18.4+）：完整语义，运行期解析为 `Volatile<T>` 引用，
 *    由 `liveConfig()` 在 `apply()` 边界透明化解引用；
 * 2. `extra('volatile', true)`（3.18.2 也有）：只设置 `meta.volatile` 标记，
 *    值保持普通对象——0.1.5 宿主没有 0.2 的 volatile 投影机制，普通值即正确行为。
 *
 * dsh 0.2 的设置服务用 `volatileForm()` 只保留 `schema.meta.volatile` 的叶子字段，
 * 因此“表单可见的字段必须经本助手标记”这一约定与原生 `.volatile()` 一致。
 */
function markVolatile<T extends { volatile?: () => unknown; extra?: (key: 'volatile', value: boolean) => unknown; meta?: Record<string, unknown> }>(schema: T): T {
  if (typeof schema.volatile === 'function') return schema.volatile() as T
  if (typeof schema.extra === 'function') return schema.extra('volatile', true) as T
  schema.meta = { ...schema.meta, volatile: true }
  return schema
}

/**
 * 插件配置 schema。
 *
 * ⚠️ **表单可见的字段必须经 `markVolatile()` 标记（见上）。**
 *
 * dsh 0.2 的设置服务在 `SettingsForms.describe()` 里用 `volatileForm()` 过滤字段
 * （见 `@deepseek-ai/dsh-settings` 的 `lib/index.js`）：
 *
 * ```js
 * function volatileForm(schema) {
 *   if (schema.meta.volatile) return plainSchema(schema);   // 只有 volatile 叶子保留
 *   if (schema.type === 'object') { ...递归... }            // 对象含存活子字段则保留
 *   // 其余标量 / 数组 / union → undefined，被丢弃
 * }
 * ```
 *
 * 被丢弃的字段不会进入表单；若一个 entry 的字段全被丢弃，该 entry 连
 * `settings.describe().namespaces` 都不出现，插件配置页拿到的 `form` 就是 `undefined`。
 *
 * **代价**：原生 `.volatile()` 标记的字段在运行期解析为引用对象（`Volatile<T>`），
 * 真值要 `.get()`。本插件在 `apply()` 边界用 `liveConfig()` 的 Proxy 统一透明化，
 * 因此内部代码仍按普通值读写，同时保留 Loader 的原地热更新语义。
 * 降级路径（`extra` / meta 直标）没有引用对象，`liveConfig()` 原样放行普通值。
 *
 * 未标记的字段保持普通值，只受 fiber 重启影响；它们不出现在配置页里，
 * 需要调整时改 profile 的 `cordis.patch.yml`。
 */
const schema = z.object({
  url: markVolatile(z.string().default('https://chat.deepseek.com')),
  // 默认由插件启动独立浏览器；attach 保留给需要复用外部 CDP 浏览器的高级用户。
  browser: z.union(['managed', 'attach']).default('managed'),
  channel: z.union(['msedge', 'chrome']).default('msedge'),
  debugPort: markVolatile(z.number().step(1).min(1024).max(65535).default(9333)),
  autoStartKeeper: z.boolean().default(true),
  stateFile: z.string(),
  profileDir: z.string(),
  sendMode: markVolatile(z.union(['manual', 'approved']).default('manual')),
  model: markVolatile(z.union([...WEB_MODEL_IDS]).default('deepseek-web')),
  selectors: z.dict(z.string()),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(600_000),
  rateLimit: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    retryDelayMs: markVolatile(z.number().step(1).min(1_000).default(30_000)),
    maxRetries: markVolatile(z.number().step(1).min(0).default(5)),
  }).default({}),
  liveThinking: markVolatile(z.boolean().default(true)),
  maxReplyBytes: z.number().step(1).min(1024).default(4 * 1024 * 1024),
  protocolRefreshEvery: markVolatile(z.number().step(1).min(1).default(8)),
  protocolEveryRequest: markVolatile(z.boolean().default(false)),
  toolAllowlist: markVolatile(z.array(z.string()).default([
    'read',
    'write',
    'edit',
    'str_replace_editor',
    'glob',
    'grep',
    'bash',
    'pwsh',
    'todo_write',
    'mcp__taptap-maker__*',
  ])),
  excludeToolNames: markVolatile(z.array(z.string()).default(['web_search'])),
  compactToolCatalog: z.boolean().default(true),
  maxToolResultChars: markVolatile(z.number().step(1).min(256).default(6_000)),
  maxGoalChars: z.number().step(1).min(64).default(2_000),
  focus: z.object({
    enabled: markVolatile(z.boolean().default(true)),
    webWindow: markVolatile(z.boolean().default(true)),
    dshWindow: markVolatile(z.boolean().default(true)),
    dshProcessNames: z.array(z.string()).default(['electron', 'dsh', 'DeepSeek Harness']),
    dshTitlePattern: z.string().default('DeepSeek Harness|dsh'),
  }).default({}),
  review: z.object({
    enabled: markVolatile(z.boolean().default(false)),
    provider: markVolatile(z.union(['kimi', 'deepseek-web', 'glm']).default('kimi')),
    url: z.string().default('https://www.kimi.com/'),
    debugPort: z.number().step(1).min(1024).max(65535).default(9334),
    profileDir: z.string(),
    streamIdleTimeoutMs: z.number().step(1).min(1).default(600_000),
    maxEvidenceChars: z.number().step(1).min(1_000).default(60_000),
    maxRounds: markVolatile(z.number().step(1).min(0).default(1)),
    glmUrl: z.string().default('https://chat.z.ai/'),
    glmDebugPort: z.number().step(1).min(1024).max(65535).default(9335),
    glmProfileDir: z.string(),
  }).default({}),
  autoCorrectMalformed: z.boolean().default(true),
  delegatedTools: markVolatile(z.array(z.string()).default(['web_search', 'web_fetch'])),
})

/**
 * Loader 面向的 schema。标了 `.volatile()` 的字段在该类型里其实是 `Volatile<T>`；
 * 这里断言成普通值形状，因为 `apply()` 边界会用 `liveConfig()` 把它还原成普通对象。
 */
export const Config = schema as unknown as z<Config>

// 说明：dsh 0.2 起设置表单由插件自身的 Config schema 自动投影
// （SettingsForms.describe()，条目键为 profile 里的插件 entry id），
// 插件不再注册自定义命名空间。因此审核、模型与工具白名单等偏好
// 统一由本文件的 Config 字段承载，0.1 时代的 REVIEW_SETTINGS_NS /
// GENERAL_SETTINGS_NS / UsageSettingsSchema 已随 installSection 一同移除。
