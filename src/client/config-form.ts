/** Configuration metadata and pure draft handling shared by the page and regression checks. */
export type FieldKind = 'boolean' | 'number' | 'text' | 'choice' | 'list'
export interface ConfigField {
  key: string
  label: string
  hint?: string
  kind: FieldKind
  defaultValue: unknown
  options?: readonly { value: string; label: string; hint?: string }[]
  min?: number
  max?: number
  unit?: string
}

export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: 'sendMode', label: '消息发送方式', hint: '可覆盖宿主当前选择的模型入口，保存后从下一轮消息生效。', kind: 'choice', defaultValue: 'model', options: [
    { value: 'model', label: '跟随模型入口', hint: '按 dsh 中选择的入口决定是否自动发送' },
    { value: 'manual', label: '半自动发送', hint: '填好内容后，由你在网页点击发送' },
    { value: 'auto', label: '全自动发送', hint: '填入消息后自动发送，连续执行任务' },
  ] },
  { key: 'liveThinking', label: '显示网页思考过程', hint: '在对话中展开网页的真实思考过程；关闭后只展示结果。', kind: 'boolean', defaultValue: false },
  { key: 'compactionLanguage', label: '长任务摘要语言', hint: '长对话压缩时，接续摘要使用的语言。', kind: 'choice', defaultValue: 'task', options: [
    { value: 'task', label: '跟随任务' }, { value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'host', label: '跟随 dsh' },
  ] },
  { key: 'browser', label: '浏览器连接方式', hint: '保存后重启 dsh 生效，当前浏览器连接会继续保留。', kind: 'choice', defaultValue: 'managed', options: [
    { value: 'managed', label: '独立浏览器', hint: '插件自动启动，单独保存登录状态' },
    { value: 'attach', label: '已有浏览器', hint: '连接已开启远程调试的浏览器' },
  ] },
  { key: 'channel', label: '使用的浏览器', kind: 'choice', defaultValue: 'msedge', options: [
    { value: 'msedge', label: 'Microsoft Edge' }, { value: 'chrome', label: 'Google Chrome' },
  ] },
  { key: 'profileDir', label: '浏览器数据目录', hint: '留空使用默认目录，保留网页登录状态。更改后使用新的目录。', kind: 'text', defaultValue: '' },
  { key: 'review.enabled', label: '交付前审核', hint: '最终结果交付前复核一次，工具执行过程不触发审核。', kind: 'boolean', defaultValue: false },
  { key: 'review.provider', label: '审核通道', kind: 'choice', defaultValue: 'kimi', options: [
    { value: 'deepseek-web', label: 'DeepSeek 自审', hint: '沿用当前对话，无需额外登录' },
    { value: 'kimi', label: 'Kimi', hint: '独立窗口，需要登录 Kimi' },
    { value: 'glm', label: 'GLM', hint: '独立窗口，需要登录 GLM' },
  ] },
  { key: 'review.maxRounds', label: '最多审核轮数', hint: '未通过时将意见交回修正；设为 0 跳过审核。', kind: 'number', defaultValue: 1, min: 0, max: 10, unit: '轮' },
  { key: 'rateLimit.enabled', label: '频控后自动重试', hint: '网页提示发送过于频繁时，等待后重发同一条消息。', kind: 'boolean', defaultValue: true },
  { key: 'rateLimit.retryDelayMs', label: '重试等待时间', kind: 'number', defaultValue: 30000, min: 1000, unit: '毫秒' },
  { key: 'rateLimit.maxRetries', label: '单轮重试上限', kind: 'number', defaultValue: 5, min: 0, max: 20, unit: '次' },
  { key: 'focus.enabled', label: '自动切换窗口', hint: '填入消息时切到网页，完成后回到 dsh。', kind: 'boolean', defaultValue: true },
  { key: 'focus.webWindow', label: '填入消息时切到网页', kind: 'boolean', defaultValue: true },
  { key: 'focus.dshWindow', label: '完成后回到 dsh', kind: 'boolean', defaultValue: true },
  { key: 'toolAllowlist', label: '允许使用的工具', hint: '留空允许全部宿主工具。支持前缀通配，例如 mcp__server__*。', kind: 'list', defaultValue: [] },
  { key: 'excludeToolNames', label: '排除的工具', hint: '即使已加入允许列表，这些工具也不会交给网页模型。', kind: 'list', defaultValue: ['web_search'] },
  { key: 'delegatedTools', label: '由网页完成的工具', hint: '交由网页自身能力处理；这里的工具不会在本地执行。', kind: 'list', defaultValue: ['web_search', 'web_fetch'] },
  { key: 'protocolEveryRequest', label: '每轮刷新工具协议', hint: '网页容易忘记工具规则时开启，会增加每轮输入长度。', kind: 'boolean', defaultValue: false },
  { key: 'protocolRefreshEvery', label: '协议刷新间隔', kind: 'number', defaultValue: 8, min: 1, unit: '轮' },
  { key: 'maxToolResultChars', label: '工具结果输入上限', hint: '超过上限的本地工具结果保留头尾；最终回复仍完整展示。', kind: 'number', defaultValue: 6000, min: 256, unit: '字符' },
  { key: 'url', label: 'DeepSeek 网页地址', kind: 'text', defaultValue: 'https://chat.deepseek.com' },
  { key: 'debugPort', label: '浏览器调试端口', hint: '连接已有浏览器时须与其端口一致；独立浏览器遇到占用会自动换用空闲端口。', kind: 'number', defaultValue: 9333, min: 1024, max: 65535 },
]

export function readConfigPath(source: unknown, key: string): unknown {
  let current = source
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function fieldValue(source: unknown, field: ConfigField): unknown {
  const value = readConfigPath(source, field.key) ?? field.defaultValue
  return field.key === 'sendMode' && value === 'approved' ? 'model' : value
}

export interface ConfigDraft<Revision = unknown> {
  /** Snapshot at the first edit. Never rebase silently over concurrent host edits. */
  base: unknown
  revision: Revision
  edits: Record<string, unknown>
}

export function editConfig<Revision>(draft: ConfigDraft<Revision> | null, accepted: unknown, revision: Revision, key: string, value: unknown): ConfigDraft<Revision> {
  return { base: draft?.base ?? accepted, revision: draft ? draft.revision : revision, edits: { ...draft?.edits, [key]: value } }
}

/** Keep raw number/list input while typing; normalize only at the persistence boundary. */
export function normalizeField(field: ConfigField, raw: unknown): unknown {
  if (field.kind === 'number') return typeof raw === 'string' && raw.trim() === '' ? undefined : Number(raw)
  if (field.kind === 'list' && typeof raw === 'string') return [...new Set(raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
  return raw
}

export function validateField(field: ConfigField, raw: unknown): string | undefined {
  const value = normalizeField(field, raw)
  if (field.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value))) return '请输入完整的整数。'
  if (typeof value === 'number' && field.min !== undefined && value < field.min) return `不能小于 ${field.min}。`
  if (typeof value === 'number' && field.max !== undefined && value > field.max) return `不能大于 ${field.max}。`
  if (field.kind === 'choice' && !field.options?.some(option => option.value === value)) return '请选择有效的选项。'
  if (field.key === 'url') {
    try { if (!['https:', 'http:'].includes(new URL(String(value)).protocol)) return '请输入 http 或 https 网页地址。' }
    catch { return '请输入完整的网页地址。' }
  }
  return undefined
}

export function draftErrors(draft: ConfigDraft | null): Record<string, string> {
  return Object.fromEntries(CONFIG_FIELDS.flatMap(field => {
    if (!draft || !Object.hasOwn(draft.edits, field.key)) return []
    const error = validateField(field, draft.edits[field.key])
    return error ? [[field.key, error]] : []
  }))
}

export function draftOperations(draft: ConfigDraft | null): { op: 'set'; path: string[]; value: never }[] {
  if (!draft) return []
  return CONFIG_FIELDS.flatMap(field => {
    if (!Object.hasOwn(draft.edits, field.key) || validateField(field, draft.edits[field.key])) return []
    const value = normalizeField(field, draft.edits[field.key])
    if (JSON.stringify(value) === JSON.stringify(fieldValue(draft.base, field))) return []
    return [{ op: 'set' as const, path: field.key.split('.'), value: value as never }]
  })
}
