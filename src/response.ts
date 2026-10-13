/**
 * 网页版回答解析：把模型的自由文本还原成 Harness 的 content block。
 *
 * 模型在网页端没有原生 tool-call 通道，因此协议要求：
 * - 要调用工具：输出包含 `actions` 的 JSON（可带 ```json 围栏）；
 * - 任务完成：直接输出正文。
 *
 * @module dsh-deepseek-web/response
 */

import type { ContentBlock, StreamChunk, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'

export interface WebToolAction {
  /** Harness 工具名。 */
  tool?: string
  /** 兼容用户方案里的 action 命名。 */
  action?: string
  params?: Record<string, unknown>
  arguments?: Record<string, unknown>
}

export interface ParsedWebReply {
  /** 是否解析出可执行动作。 */
  hasActions: boolean
  /** 规范化后的动作列表。 */
  actions: WebToolAction[]
  /** 无动作时作为最终回答的文本。 */
  text: string
}

/** 只拦截明显的未完成交接文本；用户要求摘要/分析时允许正常输出。 */
export function looksLikeUnfinishedHandoff(text: string, task: string): boolean {
  if (!task || /总结|摘要|交接|分析|解释|summari[sz]e|summary|handoff|analy[sz]e|explain/i.test(task)) return false
  const markers = [
    /(?:^|\n)\s*-\s*User asked\b/i,
    /(?:^|\n)\s*-\s*User wants\b/i,
    /(?:^|\n)\s*-\s*Prior assistant\b/i,
    /(?:^|\n)\s*##\s*Primary Request and Intent\b/i,
    /(?:^|\n)\s*##\s*(?:Pending Jobs|Current Work|Next Step)\b/i,
  ].filter(pattern => pattern.test(text)).length
  return markers >= 3 && /NOT yet|not yet|pending|尚未|待办|未完成/i.test(text)
}

/** 本地审查发现的一条动作问题。 */
export interface ActionProblem {
  /** 动作在 actions 数组中的序号。 */
  index: number
  /** 涉及的工具名（若可识别）。 */
  tool?: string
  /** 人类可读的问题说明。 */
  problem: string
}

const DESTRUCTIVE_COMMAND_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)/i, '疑似递归删除根目录/家目录'],
  [/Remove-Item\b[^\n]*-Recurse[^\n]*(?:[A-Za-z]:\\|\$env:USERPROFILE|\$HOME|~)[^\n]*$/im, '疑似递归删除系统盘/家目录'],
  [/\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart)\b/i, '疑似磁盘格式化操作'],
  [/\bformat\s+[A-Za-z]:/i, '疑似磁盘格式化操作'],
  [/\bshutdown\s+\/[sr]\b/i, '疑似关机/重启操作'],
]

/** 常见参数别名：模型有时用 path/text/cmd 等写法，执行前归一为 schema 的规范名。 */
const PARAM_ALIASES: Record<string, readonly string[]> = {
  file_path: ['file_path', 'filepath', 'filePath', 'file', 'path', 'filename', 'target', 'target_path'],
  content: ['content', 'contents', 'text', 'code', 'body', 'data', 'source'],
  command: ['command', 'cmd', 'script', 'shell', 'command_line'],
  description: ['description', 'desc', 'summary', 'reason', 'note', 'purpose'],
  pattern: ['pattern', 'glob', 'glob_pattern', 'query'],
  old_str: ['old_str', 'old_string', 'old', 'oldText'],
  new_str: ['new_str', 'new_string', 'new', 'newText'],
}

/** 按 schema 必填名做别名替换，返回修复后的参数对象。 */
function repairParams(
  params: Record<string, unknown>,
  schema: ToolSchema,
): Record<string, unknown> {
  const required = Array.isArray(schema.parameters?.required)
    ? schema.parameters.required.filter((item): item is string => typeof item === 'string')
    : []
  const repaired: Record<string, unknown> = { ...params }
  for (const name of required) {
    if (name in repaired) continue
    for (const alias of PARAM_ALIASES[name] ?? [name]) {
      if (alias === name || !(alias in repaired)) continue
      repaired[name] = repaired[alias]
      delete repaired[alias]
      break
    }
  }
  return repaired
}

/**
 * 参数别名修复 + 校验。返回可直接执行的动作列表与剩余问题。
 */
export function repairAndValidateActions(
  actions: readonly WebToolAction[],
  allowedToolNames: ReadonlySet<string>,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
): { actions: WebToolAction[]; problems: ActionProblem[] } {
  const repairedActions = actions.map((action) => {
    const tool = action.tool ?? action.action
    const schema = tool ? toolSchemas?.get(tool) : undefined
    const params = action.params ?? action.arguments
    if (!schema || !params || typeof params !== 'object' || params === null) return action
    return {
      ...action,
      params: repairParams(params as Record<string, unknown>, schema),
    }
  })
  return { actions: repairedActions, problems: validateActions(repairedActions, allowedToolNames, toolSchemas) }
}

/**
 * 执行前的确定性审查：工具必须在本轮可见清单里、参数必须是对象、
 * 明显破坏性的命令直接拒绝。返回空数组表示通过。
 */
export function validateActions(
  actions: readonly WebToolAction[],
  allowedToolNames: ReadonlySet<string>,
  toolSchemas?: ReadonlyMap<string, ToolSchema>,
): ActionProblem[] {
  const problems: ActionProblem[] = []
  actions.forEach((action, index) => {
    const tool = action.tool ?? action.action
    if (!tool) {
      problems.push({ index, problem: '缺少 tool 字段' })
      return
    }
    if (!allowedToolNames.has(tool)) {
      problems.push({ index, tool, problem: `工具 "${tool}" 不在本轮可用工具清单中` })
    }
    const params = action.params ?? action.arguments
    if (params !== undefined && (typeof params !== 'object' || params === null)) {
      problems.push({ index, tool, problem: 'arguments 必须是 JSON 对象' })
      return
    }
    const schema = tool ? toolSchemas?.get(tool) : undefined
    if (schema) {
      const parameters = schema.parameters ?? {}
      const required = Array.isArray(parameters.required)
        ? parameters.required.filter((item): item is string => typeof item === 'string')
        : []
      const present = (params ?? {}) as Record<string, unknown>
      const missing = required.filter(name => !(name in present))
      if (missing.length > 0) {
        problems.push({
          index,
          tool,
          problem: `缺少必填参数 ${missing.map(name => `"${name}"`).join('、')}`,
        })
      }
      const properties = parameters.properties
      if (properties && typeof properties === 'object') {
        for (const [name, rawSpec] of Object.entries(properties as Record<string, unknown>)) {
          if (!(name in present)) continue
          const expected = rawSpec && typeof rawSpec === 'object'
            ? (rawSpec as { type?: unknown }).type
            : undefined
          if (typeof expected !== 'string') continue
          const value = present[name]
          const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
          const accepted = expected === 'integer'
            ? actual === 'number' && Number.isInteger(value)
            : actual === expected
          if (!accepted) {
            problems.push({ index, tool, problem: `参数 "${name}" 类型应为 ${expected}，实际是 ${actual}` })
          }
        }
      }
    }
    const text = JSON.stringify(params ?? {})
    for (const [pattern, reason] of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(text)) {
        problems.push({ index, tool, problem: reason })
        break
      }
    }
  })
  return problems
}

/** 剥掉 ```json ... ``` 以及模型可能带上的前后缀，找到最靠后的 JSON 对象。 */
export function extractJsonObject(text: string): unknown | undefined {
  let candidate = text.trim()
  // 去掉整体围栏
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i)
  if (fenced) candidate = fenced[1]!.trim()

  // 模型偶发把 JSON 放在 prose 中间：直接找最长的 { ... } 平衡段
  for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

function normalizeParams(action: WebToolAction): Record<string, unknown> {
  const params = action.params ?? action.arguments ?? {}
  return typeof params === 'object' && params !== null
    ? params as Record<string, unknown>
    : { value: params }
}

export function parseWebReply(text: string): ParsedWebReply {
  const trimmed = text.trim()
  const parsed = extractJsonObject(trimmed)
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const rawActions = obj.actions ?? obj.action
    const actions: WebToolAction[] = []
    if (Array.isArray(rawActions)) {
      for (const item of rawActions) {
        if (typeof item === 'object' && item !== null) actions.push(item as WebToolAction)
      }
    } else if (typeof rawActions === 'object' && rawActions !== null) {
      actions.push(rawActions as WebToolAction)
    }
    if (actions.length > 0) {
      return {
        hasActions: true,
        actions: actions.map(a => ({
          ...a,
          tool: a.tool ?? a.action,
          params: normalizeParams(a),
        })),
        text: trimmed,
      }
    }
    // 兼容 {"action": "read_file", "params": {...}} 的单动作形态
    if (typeof obj.action === 'string' || typeof obj.tool === 'string') {
      const single = obj as unknown as WebToolAction
      return {
        hasActions: true,
        actions: [{ ...single, tool: single.tool ?? single.action, params: normalizeParams(single) }],
        text: trimmed,
      }
    }
  }
  return { hasActions: false, actions: [], text: trimmed }
}

/**
 * 判断一段“没有解析出动作”的回复是否明显是想调用工具但格式坏了：
 * 空回复、带 JSON 围栏、或出现了 JSON 形态的动作字段。
 */
export function looksLikeIntendedToolReply(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (/^```(?:json)?/im.test(trimmed)) return true
  if (/["']?(?:actions|tool|action)["']?\s*:/i.test(trimmed)) return true
  if (/^[[{]/.test(trimmed) && /["']?(?:actions|tool|action)["']?\s*:/i.test(trimmed)) return true
  return false
}

/** 模型明明有工具可用，却声称“没有工具/无法访问本地”时视为拒绝型漂移。 */
export function looksLikeToolDenial(text: string): boolean {
  return /无法访问|不能访问|无权访问|无法读取|没有(?:任何)?(?:本地)?(?:文件)?工具|工具(?:不可用|不存在)|没有实际工具|I (?:can't|cannot|do not|don't) (?:access|read)|no (?:local )?(?:file )?access|no tools (?:available|provided)/i.test(text)
}

/** 模型反问“请提供任务”时视为会话上下文丢失，需要一次性恢复协议与任务锚点。 */
export function looksLikeTaskRequest(text: string): boolean {
  return /请(?:提供|告诉|说明|发送|描述).{0,12}(?:任务|需求|要求|要做什么)|没有(?:收到|看到|收到具体的).{0,8}任务|未(?:提供|收到).{0,8}任务|what (?:task|would you like|do you want)|provide .{0,20}task|please (?:tell|provide|send).{0,20}task/i.test(text)
}

/**
 * 把解析结果转成 Harness StreamChunk 序列。
 * 顺序：文本块 → 若干 tool-call 块 → finish。
 *
 * `startIndex` 是本条助手消息内第一个空闲内容块序号：同一消息里若已经
 * 流式输出过 reasoning（实时思考流）块，正文块要从更高的序号开始，
 * 避免与已有块冲突。`nextCallId` 控制工具调用 id 的起始编号。
 */
export function* replyChunks(
  reply: ParsedWebReply,
  options: { startIndex?: number; nextCallId?: number } = {},
): Generator<StreamChunk> {
  const startIndex = options.startIndex ?? 0
  let nextCallId = options.nextCallId ?? 1
  const blocks: ContentBlock[] = []
  let textBlock: ContentBlock | undefined
  if (!reply.hasActions && reply.text.length > 0) {
    textBlock = { type: 'text', text: reply.text }
    blocks.push(textBlock)
  }

  let index = startIndex
  if (textBlock) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: reply.text }
    yield { type: 'block-end', index, block: textBlock }
    index++
  }

  const toolCalls: ContentBlock[] = []
  for (const action of reply.actions) {
    if (!action.tool) continue
    // ToolCallId is a branded string at type level; no runtime wrapper is needed.
    const id = `web-${nextCallId++}` as ToolCallId
    const argumentsJson = JSON.stringify(action.params ?? {})
    const block: ContentBlock = { type: 'tool-call', id, name: action.tool, arguments: argumentsJson }
    toolCalls.push(block)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index,
      id,
      name: action.tool,
      argumentsDelta: argumentsJson,
    }
    yield { type: 'block-end', index, block }
    index++
  }

  if (reply.hasActions && toolCalls.length > 0) {
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } else if (textBlock) {
    yield { type: 'finish', reason: { kind: 'stop' } }
  } else if (reply.hasActions) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: '模型请求了工具但缺少可识别的工具名',
          code: 'MALFORMED_TOOL_CALL',
        },
      },
    }
  } else {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
