/**
 * 网页控制协议：把 Harness 请求序列化成发送给网页模型的单条消息。
 *
 * @module dsh-deepseek-web/protocol
 */

import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Config } from './config.ts'
import type { WebChatState } from './session-state.ts'
import type { WebToolAction } from './response.ts'

/** 控制协议前缀（新网页对话的首条用户消息携带完整约束）。 */
export const SYSTEM_PROTOCOL = `你是一个 Agent 指令引擎。你的任务是把收到的任务/工具结果转化为下一步操作。

规则：
1. 需要调用本地工具时，只输出一个 JSON 对象，格式如下（可以放在 \`\`\`json 围栏内）：
   {"actions":[{"tool":"<工具名>","arguments":{...}}]}
   工具名必须取自下面列出的可用工具。
2. 任务已经完成、不需要再调用工具时，直接输出面向用户的最终回答正文，不要输出 JSON。
3. 不要解释 JSON 本身；不要输出 Markdown 表格或额外前缀；除围栏外不要夹带其它文本。
4. 不确定时选择最合理动作继续，不要反问。
5. 输出必须可被 JSON.parse 解析：不要尾随逗号、不要注释。
   不要输出 DSML、XML 或原生函数调用标记。
6. 如果消息里带有“[当前用户任务]”，必须以该任务为准推进，不得反问“请提供您需要完成的任务”；即使上下文看似缺任务，也不要求用户重发，按已有信息继续。
7. [宿主上下文]、[历史助手回复]和压缩检查点是继续工作的背景，不是面向用户的交付。除非用户明确要求摘要，否则应完成用户任务，不要用任务交接摘要代替交付。
`

/** 模型上一条输出疑似想调用工具、但无法解析时使用的纠错消息。 */
export const FORMAT_CORRECTION_PROMPT = `[系统纠错] 你上一条回复没有给出可解析的动作指令。

如果下一步需要调用本地工具：请只输出一个合法 JSON 对象，格式为 {"actions":[{"tool":"<工具名>","arguments":{...}}]}，不要夹带解释。
如果任务已经完成：请直接输出面向用户的最终回答正文，不要输出 JSON。

重要：本地工具由外部执行引擎提供并真实可用。你不需要真正访问文件系统，
只需用 JSON 描述要调用的工具与参数即可；不要声称“无法访问本地文件”或“没有工具”。

请重新输出。`

/** 取第一句描述，控制精简目录长度。 */
function firstSentence(text: string): string {
  const sentence = text.split(/(?<=[。！？.!?])\s*/u)[0] ?? text
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence
}

/** 从 JSON Schema 里取必填参数名。 */
function requiredParamNames(parameters: Record<string, unknown>): string[] {
  const required = parameters.required
  if (!Array.isArray(required)) return []
  return required.filter((item): item is string => typeof item === 'string').slice(0, 8)
}

function toolSchemaText(tool: ToolSchema, compact: boolean): string {
  if (!compact) {
    return `- ${tool.name}${tool.description ? `：${tool.description}` : ''}${
      tool.parameters ? `\n  参数: ${JSON.stringify(tool.parameters)}` : ''
    }`
  }
  const required = requiredParamNames(tool.parameters ?? {})
  return `- ${tool.name}：${firstSentence(tool.description ?? '')}${
    required.length > 0 ? `（必填: ${required.join(', ')}）` : ''
  }`
}

export function buildToolCatalog(tools?: ToolSchema[], compact = true): string {
  if (!tools || tools.length === 0) return ''
  return `可用工具：\n${tools.map(tool => toolSchemaText(tool, compact)).join('\n')}`
}

export function shouldRefreshProtocol(state: WebChatState, config: Config): boolean {
  return state.roundsSinceProtocol >= config.protocolRefreshEvery
}

export function needsProtocolNow(state: WebChatState, config: Config): boolean {
  return config.protocolEveryRequest || !state.initialized || shouldRefreshProtocol(state, config)
}

/**
 * 由 Harness 的一条内容块得到可安全送入网页的文本。
 * 图片/文件会被降级为描述文本（网页版图片上传后续再做）。
 *
 * 工具结果自 dsh 0.2 起是独立的消息角色（`role: 'tool'`），不再是内容块，
 * 因此这里没有 `tool-result` 分支；对未知块保持兜底文本。
 */
export function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'image':
      return `[图片附件 ${block.attachment.attachmentId}]`
    case 'file':
      return `[文件附件 ${block.attachment.attachmentId}: ${block.attachment.name}]`
    case 'tool-call':
      return `[请求调用工具 ${block.name}]`
    case 'tool-addition':
      return `[启用工具 ${block.toolName}]`
    case 'tool-removal':
      return `[停用工具 ${block.toolName}]`
    default: {
      // dsh 0.1 里工具结果曾是内容块（`type: 'tool-result'`，带 content 数组），
      // 0.2 起升格为 `role: 'tool'` 的消息，该块类型已从 ContentBlockMap 移除。
      // 这里按结构兜底递归展开，使同一份产物在 0.1 宿主上也不会退化成「未知内容」。
      const nested = (block as unknown as { content?: unknown }).content
      if (Array.isArray(nested)) {
        return nested.map(item => blockToText(item as ContentBlock)).join('\n')
      }
      return '[未知内容]'
    }
  }
}

function clampToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n…（工具输出过长，已截断 ${text.length - maxChars} 字符）…\n${text.slice(-tail)}`
}

/**
 * 一条工具结果送入网页模型时的文本形态。
 *
 * 参数用结构类型而非具体消息类型，因为工具结果在不同 dsh 版本里形状不同：
 * 0.2 起是 `role: 'tool'` 的 `ToolResultMessage`，0.1 时是 `role: 'user'`
 * 且 `source.kind === 'tool'` 的消息。两者都只有 `content` 与 `isError` 参与渲染。
 *
 * @param assistantCall - 触发本次结果的上一条 assistant 工具调用块，用于标注工具名与参数。
 * @param message - 承载结果的工具结果消息。
 * @param maxChars - 送入网页的最大字符数，超出按头尾截断。
 * @returns 可直接并入网页提示词的结果段落。
 */
export function toolResultToWebMessage(
  assistantCall: ContentBlock | undefined,
  message: { readonly content: readonly ContentBlock[]; readonly isError?: boolean },
  maxChars = 6_000,
): string {
  const callName = assistantCall?.type === 'tool-call' ? assistantCall.name : undefined
  const callArgs = assistantCall?.type === 'tool-call' ? assistantCall.arguments : undefined
  const body = clampToolResult(message.content.map(block => blockToText(block)).join('\n'), maxChars)
  const head = callName ? `工具 ${callName} 的执行结果` : '工具执行结果'
  const failed = message.isError === true ? '（执行失败）' : ''
  return `${head}${failed}${callArgs ? `（参数: ${callArgs.slice(0, 800)}）` : ''}：\n${body}`
}

function clampGoal(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（任务描述过长，已截断）`
}

/**
 * 一次性恢复提示：上下文疑似丢失（反问任务、格式漂移、拒绝执行）时，
 * 重新注入完整协议 + 精简工具目录 + 任务锚点。
 */
export function buildRecoveryPrompt(
  options: GenerateOptions,
  state: WebChatState,
  config: Config,
): string {
  const tools = visibleToolsOf(options, config)
  const catalog = buildToolCatalog(tools, config.compactToolCatalog)
  const anchor = state.goalText
    ? `[当前用户任务]\n${clampGoal(state.goalText, config.maxGoalChars)}`
    : ''
  return [
    SYSTEM_PROTOCOL,
    catalog && `当前任务上下文可用的工具：\n${catalog}`,
    anchor,
    FORMAT_CORRECTION_PROMPT,
  ].filter(Boolean).join('\n\n')
}

/** 按白名单/排除名单筛选网页模型可见的工具；委托工具不进入本地执行集合，只出现在提示词目录里。 */
export function visibleToolsOf(options: GenerateOptions, config: Config): ToolSchema[] {
  const allow = new Set(config.toolAllowlist)
  const exclude = new Set(config.excludeToolNames)
  const delegated = new Set(config.delegatedTools)
  const matches = (set: Set<string>, name: string): boolean => {
    if (set.size === 0) return false
    if (set.has(name)) return true
    for (const item of set) {
      if (item.endsWith('*') && name.startsWith(item.slice(0, -1))) return true
    }
    return false
  }
  return (options.tools ?? []).filter(tool =>
    (allow.size === 0 || matches(allow, tool.name))
    && !matches(exclude, tool.name)
    && !delegated.has(tool.name))
}

/** 委托工具的目录说明：告诉网页模型调用会被转交它自带能力执行。 */
const DELEGATED_CATALOG_LINES: Record<string, string> = {
  web_search: '需要最新网络信息时调用；调用后系统会把查询转交你自带的联网搜索，请在下一轮按提示给出带来源的要点。',
  web_fetch: '需要读取指定网页内容时调用；调用后系统会转交你自带的网页浏览能力，请在下一轮给出要点总结。',
}

/** 组装委托工具的目录段；空集合返回空串。 */
export function buildDelegatedCatalog(delegated: readonly string[]): string {
  if (delegated.length === 0) return ''
  const lines = delegated.map(name =>
    `- ${name}：${DELEGATED_CATALOG_LINES[name] ?? '调用后由网页端自带能力代执行，请在下一轮按提示给出结果。'}`)
  return `网页委托工具（声明调用后由你的网页能力代为执行）：\n${lines.join('\n')}`
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 任务简报的单节最大字符数（按节截断，防止简报把新对话首轮撑爆）。 */
const HANDOFF_SECTION_MAX = 500

/** 截断单行文本：超长按省略号收尾。 */
function clampHandoff(text: string, max = HANDOFF_SECTION_MAX): string {
  const trimmed = text.replace(/\s+/gu, ' ').trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** 解析 todo_write 最后一次调用的待办清单（兼容常见字段命名）。 */
function parseTodos(argsJson: string | undefined): Array<{ content: string; status: string }> {
  if (!argsJson) return []
  try {
    const parsed = JSON.parse(argsJson) as { todos?: unknown; items?: unknown }
    const list = Array.isArray(parsed.todos) ? parsed.todos : Array.isArray(parsed.items) ? parsed.items : []
    const todos: Array<{ content: string; status: string }> = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const content = typeof record.content === 'string' ? record.content
        : typeof record.title === 'string' ? record.title
        : typeof record.text === 'string' ? record.text : ''
      if (!content) continue
      const rawStatus = typeof record.status === 'string' ? record.status
        : typeof record.state === 'string' ? record.state : 'pending'
      const status = /complete|done|finished/i.test(rawStatus) ? 'completed'
        : /progress|active|current|doing/i.test(rawStatus) ? 'in_progress'
        : 'pending'
      todos.push({ content, status })
    }
    return todos
  } catch {
    return []
  }
}

/** 提取一次工具调用的关键参数摘要（文件路径 / 命令 / 模式 / 查询词）。 */
function summarizeToolCall(name: string, argsJson: string | undefined): string {
  let args: Record<string, unknown> = {}
  try { args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {} } catch { /* 参数非 JSON 时忽略 */ }
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  if (name === 'todo_write') return '（更新任务清单）'
  const detail = pick('file_path', 'path', 'notebook_path', 'command', 'url', 'query', 'pattern', 'skill')
  return detail ? `${name}: ${clampHandoff(detail, 120)}` : name
}

/**
 * 构建轮换新对话时的任务简报：从 Harness 会话日志（options.messages）提取
 * 原始任务、已完成事项、当前进度与最近工具结果，让接续对话无需用户重新解释。
 */
export function buildHandoffBrief(
  options: GenerateOptions,
  state: WebChatState,
): string {
  const messages = options.messages
  let originalTask = ''
  let latestTask = ''
  let lastAssistantText = ''
  let pendingCall: string | undefined
  const filesTouched: string[] = []
  const recentResults: string[] = []
  let todos: Array<{ content: string; status: string }> = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          pendingCall = block.name
          if (block.name === 'todo_write') todos = parseTodos(block.arguments)
          if (/^(write|edit|str_replace_editor)$/.test(block.name)) {
            try {
              const args = JSON.parse(block.arguments) as Record<string, unknown>
              const filePath = typeof args.file_path === 'string' ? args.file_path
                : typeof args.path === 'string' ? args.path : undefined
              if (filePath && !filesTouched.includes(filePath)) filesTouched.push(filePath)
            } catch { /* 参数非 JSON 时忽略 */ }
          }
        }
        if (block.type === 'text' && block.text.trim()) lastAssistantText = block.text.trim()
      }
      continue
    }
    // 工具结果：dsh 0.2 起是独立角色 `role: 'tool'`；0.1 时是 user 消息 + source.kind 'tool'。
    if (message.role === 'tool' || (message.role === 'user' && message.source?.kind === 'tool')) {
      const output = clampHandoff(message.content.map(block => blockToText(block)).join('\n'), 160)
      recentResults.push(`${pendingCall ?? 'tool'}: ${output}`)
      if (recentResults.length > 3) recentResults.shift()
      continue
    }
    if (message.role === 'user' && message.source?.kind === 'user') {
      const text = message.content.map(blockToText).join('\n').replace(/\s+/gu, ' ').trim()
      if (!text) continue
      if (!originalTask) originalTask = text
      latestTask = text
    }
  }
  if (!latestTask && state.goalText) latestTask = state.goalText

  const completed = todos.filter(item => item.status === 'completed').map(item => clampHandoff(item.content, 160))
  const inProgress = todos.filter(item => item.status === 'in_progress').map(item => clampHandoff(item.content, 160))
  const pending = todos.filter(item => item.status === 'pending').map(item => clampHandoff(item.content, 160))

  const sections: string[] = []
  sections.push(`[任务简报]\n原始任务：${clampHandoff(originalTask || state.goalText || '（未能从会话日志提取）')}`)
  if (latestTask && latestTask !== originalTask) {
    sections.push(`最新任务指令：${clampHandoff(latestTask, 300)}`)
  }

  const doneLines: string[] = []
  if (filesTouched.length > 0) doneLines.push(`- 已产出/修改的文件：${clampHandoff(filesTouched.join('、'), 400)}`)
  for (const item of completed) doneLines.push(`- 已完成：${item}`)
  if (doneLines.length === 0 && lastAssistantText) doneLines.push(`- 最近结论：${clampHandoff(lastAssistantText, 300)}`)
  if (doneLines.length > 0) sections.push(`[已完成]\n${doneLines.join('\n')}`)

  const progressLines: string[] = []
  for (const item of inProgress) progressLines.push(`- 正在进行：${item}`)
  for (const result of recentResults) progressLines.push(`- 最近工具结果：${result}`)
  if (progressLines.length > 0) sections.push(`[当前进度]\n${progressLines.join('\n')}`)

  if (pending.length > 0) {
    sections.push(`[下一步]\n${pending.map(item => `- 待办：${item}`).join('\n')}`)
  }

  sections.push(
    '[上下文说明]\n本对话是自动开启的接续对话，之前的对话因上下文长度达到阈值而归档。\n'
    + '请基于以上简报继续任务，不要反问「请提供任务」。如需早期细节，可用工具重新读取相关文件。',
  )
  const hostContext = (options.messages as RequestMessage[]).filter(message =>
    ['system', 'developer'].includes(message.role) || isCheckpoint(message)
    || (message.role === 'user' && sourceKind(message) !== undefined
      && !['user', 'tool'].includes(sourceKind(message)!)))
  if (options.system) sections.push(`[宿主系统指令]\n${options.system}`)
  for (const message of hostContext) sections.push(`[宿主上下文]\n${replayText(message)}`)
  return sections.join('\n\n')
}

/** 把一次委托调用翻译成网页端下一轮提示词；无法提取参数时返回 undefined（记日志跳过）。 */
export function buildDelegationPrompt(tool: string, action: WebToolAction): string | undefined {
  const args = action.arguments ?? action.params ?? {}
  if (tool === 'web_search') {
    const query = firstString(args, ['query', 'q', 'search', 'keyword', 'keywords'])
    if (!query) return undefined
    return `[工具委托：web_search]\n请使用你自带的联网搜索能力，搜索：${query}\n给出要点与来源链接。本条是工具委托，不需要再输出工具调用 JSON。`
  }
  if (tool === 'web_fetch') {
    const url = firstString(args, ['url', 'link', 'target', 'page'])
    if (!url) return undefined
    return `[工具委托：web_fetch]\n请访问并阅读该网页：${url}\n总结页面要点（附来源）。本条是工具委托，不需要再输出工具调用 JSON。`
  }
  return `[工具委托：${tool}]\n请在网页端用你自带的能力完成：${tool} ${JSON.stringify(args).slice(0, 600)}\n给出结果说明。本条是工具委托，不需要再输出工具调用 JSON。`
}

/**
 * 收集审核证据：用户任务 + 产出正文 + 最近写入/编辑的文件内容。
 */
export async function buildReviewEvidence(
  options: GenerateOptions,
  state: WebChatState,
  artifact: string,
  maxChars: number,
): Promise<{ task: string; artifact: string; files: string[] }> {
  // 同一文件只保留最后一次写入/编辑的内容，避免多轮改写把证据撑爆
  const latestByPath = new Map<string, string>()
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      if (!/^(write|edit|str_replace_editor)$/.test(block.name)) continue
      try {
        const args = JSON.parse(block.arguments) as Record<string, unknown>
        const filePath = typeof args.file_path === 'string'
          ? args.file_path
          : typeof args.path === 'string' ? args.path : undefined
        const content = typeof args.content === 'string'
          ? args.content
          : typeof args.new_string === 'string' ? args.new_string : undefined
        if (filePath && content) latestByPath.set(filePath, content)
      } catch {
        // 参数不是合法 JSON 时跳过该证据
      }
    }
  }
  const files = [...latestByPath.keys()].slice(-10)
  // 磁盘上的文件才是权威内容：能读到就覆盖工具参数里的片段证据
  for (const filePath of files) {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
    try {
      latestByPath.set(filePath, await readFile(absolute, 'utf8'))
    } catch {
      // 读不到就沿用写入参数里的内容
    }
  }
  const answerBudget = Math.max(2_000, Math.floor(maxChars * 0.3))
  const answer = artifact.length <= answerBudget
    ? artifact
    : `${artifact.slice(0, answerBudget)}\n…（回答正文已截断，仅为节选）`
  const sections = [`[交付说明/回答]\n${answer}`]
  let used = sections[0]!.length
  for (const filePath of files) {
    const content = latestByPath.get(filePath)!
    const header = `--- ${filePath} ---\n`
    const remaining = maxChars - used
    if (remaining <= header.length + 200) {
      sections.push(`…（审核证据被截断：剩余文件未纳入本次审核；这是审核通道的截断，不代表产出文件不完整）`)
      break
    }
    if (content.length + header.length <= remaining) {
      sections.push(`${header}${content}`)
      used += header.length + content.length
    } else {
      sections.push(`${header}${content.slice(0, remaining - header.length)}\n…（审核证据被截断：该文件内容到此为止是审核通道的截断，不代表产出文件不完整）`)
      break
    }
  }
  return {
    task: state.goalText ?? '',
    artifact: sections.join('\n\n'),
    files,
  }
}

export interface RenderedUserPrompt {
  /** 首条消息是否应携带完整协议。 */
  includeProtocol: boolean
  /** 组装后的单条网页用户消息。 */
  text: string
  /** 是否初始化新网页对话（包含系统协议）。 */
  initialize: boolean
}

const CONTEXT_VERSION = 1

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 兼容 dsh 的可扩展来源类型，不把内部上下文误当真实用户任务。 */
function sourceKind(message: RequestMessage): string | undefined {
  return (message.source as { kind?: string } | undefined)?.kind
}

function isUserTask(message: RequestMessage): boolean {
  return message.role === 'user' && (sourceKind(message) === undefined || sourceKind(message) === 'user')
}

/** 旧版插件可能把官方压缩指令存进 goalText；只识别明确的指令组合。 */
export function isCompactionDirective(text: string): boolean {
  return /acting as a compaction engine/i.test(text)
    && /(?:English engineering prose|structured checkpoint)/i.test(text)
    && /(?:Output only the checkpoint|Condense the conversation ABOVE)/i.test(text)
}

function isCheckpoint(message: RequestMessage): boolean {
  const kind = sourceKind(message)
  return kind === 'compact-checkpoint'
    || (kind !== 'user' && message.content.some(block =>
      block.type === 'text' && block.text.includes('<compacted-summary>')))
}

/** 回放保留助手的工具名称/完整参数，思考块不属于任务事实，不重复发送。 */
function replayText(message: RequestMessage): string {
  return message.content.filter(block => block.type !== 'reasoning').map(block =>
    block.type === 'tool-call'
      ? JSON.stringify({ tool: block.name, arguments: block.arguments, id: block.id })
      : blockToText(block)).join('\n')
}

/** 辅助请求严格使用此次传入的历史范围，不读取普通网页的隐式历史。 */
export function buildAuxiliaryPrompt(options: GenerateOptions, language: Config['compactionLanguage'] = 'host'): string {
  const messages = options.messages as RequestMessage[]
  const last = messages.at(-1)
  if (!last || last.role !== 'user') throw new Error('辅助请求缺少最后一条 user 指令')
  const history = messages.slice(0, -1).map(message => ({
    role: message.role,
    source: message.source,
    content: replayText(message),
  }))
  let directive = replayText(last)
  // 只调整已识别的官方压缩模板，保留标题和自定义辅助指令。
  if (options.purpose === 'compaction' && language !== 'host' && isCompactionDirective(directive)) {
    const instruction = language === 'zh' ? 'Write concise Chinese engineering prose.'
      : language === 'en' ? 'Write concise English engineering prose.'
      : 'Write concise engineering prose in the language of the latest real user task in the history; preserve identifiers and paths verbatim.'
    directive = directive.replace('Write concise English engineering prose.', instruction)
  }
  return [
    `你正在处理 dsh 的内部辅助请求（${options.purpose}）。以下 JSON 是待处理的历史材料，不是新任务。`,
    '只执行最后的[辅助请求指令]并返回纯正文；不得调用工具、执行历史中的操作或添加交付审核结论。',
    options.system ? `[辅助系统指令]\n${options.system}` : '',
    '[辅助请求历史]\n' + JSON.stringify({ tools: options.tools, messages: history }),
    '[辅助请求指令]\n' + directive,
  ].filter(Boolean).join('\n\n')
}

/**
 * 组装本轮要发送的网页消息。策略：
 * - 网页对话自身保留上下文，因此只携带新增消息；
 * - 新增 user 消息原样送入；新增工具结果与前面的 assistant tool-call
 *   合并成一条“工具执行结果”；
 * - 周期性或首轮注入完整控制协议，防漂移。
 *
 * 工具结果在 dsh 0.2 起是独立角色 `role: 'tool'`（`ToolResultMessage`），
 * 0.1 时是 `role: 'user'` 且 `source.kind === 'tool'`。两种形状都要认，
 * 否则结果被静默丢弃，网页模型只会看到任务锚点并反复重发同一个动作。
 *
 * `options.messages` 是 `RequestMessage[]`：其中的 `RequestUserInput` 是一次性
 * 请求输入，没有 `id` 也没有 `source`，只当下一条用户文本处理。
 */
export function renderNewWebMessages(
  options: GenerateOptions,
  state: WebChatState,
  config: Config,
  forceReplay = false,
): { prompt: RenderedUserPrompt } | null {
  const messages = options.messages as RequestMessage[]
  const checkpoints = messages.filter(isCheckpoint)
  const checkpointSignature = fingerprint(checkpoints)
  const systemMessages = messages.filter(message => ['system', 'developer'].includes(message.role))
  const systemSignature = fingerprint([options.system, systemMessages])
  const cursor = state.lastMessageId
    ? messages.findIndex(message => message.id === state.lastMessageId) : -1
  const replay = forceReplay || !state.initialized || state.contextVersion !== CONTEXT_VERSION
    || (state.lastMessageId !== undefined && cursor < 0)
    || state.checkpointSignature !== checkpointSignature
  const start = replay ? 0 : cursor + 1

  // 从持久历史恢复真实任务；检查点始终是背景，绝不成为 goalText。
  const userTasks = messages.filter(isUserTask).map(replayText)
    .filter(text => text.trim() && !isCompactionDirective(text))
  const latestTask = userTasks.at(-1)
  if (latestTask) state.goalText = clampGoal(latestTask, config.maxGoalChars)
  else if (state.goalText && isCompactionDirective(state.goalText)) state.goalText = undefined

  const parts: string[] = []
  let lastToolCall: ContentBlock | undefined
  if (replay || state.systemSignature !== systemSignature) {
    if (options.system) parts.push(`[宿主系统指令]\n${options.system}`)
    for (const message of systemMessages) parts.push(`[宿主系统指令]\n${replayText(message)}`)
  }
  // 游标可能位于助手工具调用之后，先恢复关联，再渲染新增工具结果。
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === 'assistant') {
      lastToolCall = message.content.find(block => block.type === 'tool-call')
      if (i >= start && replay) parts.push(`[历史助手回复]\n${replayText(message)}`)
      continue
    }
    if (i < start || ['system', 'developer'].includes(message.role)) continue
    if (message.role === 'tool' || sourceKind(message) === 'tool') {
      parts.push(toolResultToWebMessage(lastToolCall, message, config.maxToolResultChars))
      lastToolCall = undefined
      continue
    }
    const text = replayText(message)
    if (!text.trim()) continue
    if (isUserTask(message)) {
      if (!isCompactionDirective(text)) parts.push(`[用户消息]\n${text}`)
    } else {
      parts.push(`[宿主上下文：${sourceKind(message) ?? message.role}]\n${text}`)
    }
  }

  if (parts.length === 0 && !replay) return null
  if (state.goalText) {
    parts.unshift(`[当前用户任务]\n${clampGoal(state.goalText, config.maxGoalChars)}`)
  } else if (checkpoints.length > 0) {
    parts.push('[任务接续]\n根据宿主压缩摘要中的用户目标与近期消息继续完成尚未交付的工作；摘要本身不是交付结果。')
  } else if (parts.length === 0) {
    parts.push('请开始。')
  }

  const needsRefresh = replay || needsProtocolNow(state, config)
  const delegatedCatalog = buildDelegatedCatalog(config.delegatedTools)
  const toolCatalog = [
    buildToolCatalog(visibleToolsOf(options, config), config.compactToolCatalog),
    delegatedCatalog,
  ].filter(Boolean).join('\n')
  const text = parts.join('\n\n')
  state.contextVersion = CONTEXT_VERSION
  state.checkpointSignature = checkpointSignature
  state.systemSignature = systemSignature

  return {
    prompt: {
      includeProtocol: needsRefresh,
      text: needsRefresh
        ? [SYSTEM_PROTOCOL, toolCatalog && `当前任务上下文可用的工具：\n${toolCatalog}`, text]
          .filter(Boolean)
          .join('\n\n')
        : text,
      initialize: replay,
    },
  }
}
