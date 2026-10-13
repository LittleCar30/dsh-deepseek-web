/**
 * 插件配置页（dsh 0.2）。
 *
 * dsh 0.2 的插件配置界面不再是「Config schema 自动投影」，而是由插件客户端半侧
 * 显式注册到 Plugin Manager 声明的 slot 上。本文件注册 `plugins.row.config`，
 * key 为 `<包名>#<行 id>`，即 `dsh-deepseek-web#llm-deepseek-web`；侧栏「插件」页
 * → 组合包 `dsh-deepseek-web` → 行 `llm-deepseek-web` 上会因此多出「配置」入口。
 *
 * 读写全部走宿主传入的 `form`（`ConfigPageForm`）：
 * - `form.state` 是 `ConfigFormSnapshot`，含解析后的 `value`、`revision`、`writable`；
 * - `form.mutate(ops, revision)` 用路径操作原子提交多字段修改。
 *
 * 表单是暂存式的：只有点「保存」才写入，离开页面丢弃草稿。这与上游
 * 「只有保存才写入」的契约一致。
 *
 * @module dsh-deepseek-web/client/config-page
 */

import { useState } from 'react'
import type { JSX } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

/** 本包在 profile 里的 npm 包名。 */
export const PACKAGE_NAME = 'dsh-deepseek-web'

/** 插件入口在包自带 patch 里声明的行 id；与包名一起构成槽位 key，也是宿主的 settings entry id。 */
export const ROW_ENTRY_ID = 'llm-deepseek-web'

/** 本插件在 Plugin Manager 里的 `plugins.row.config` 槽位 key。 */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`

/** 一步路径，对应 `SettingsPathOpView.path`。 */
type FieldPath = readonly string[]

/** 配置页暴露的一个字段。 */
interface FieldSpec {
  /** 相对配置根对象的路径；嵌套段逐级展开。 */
  readonly path: FieldPath
  /** 行标签。 */
  readonly label: string
  /** 补充说明。 */
  readonly hint?: string
  /** 控件类型。 */
  readonly kind: 'boolean' | 'number' | 'text' | 'select' | 'list'
  /** `select` 的可选值。 */
  readonly options?: readonly string[]
  /** `number` 的上下界。 */
  readonly min?: number
  readonly max?: number
}

/**
 * 配置页暴露的字段集合。
 *
 * 只列真正需要在部署间调整的项；安全不变量（如协议常量）与纯代码常量不在此列。
 * 未在此列出的字段仍可通过 profile 的 `cordis.patch.yml` 覆盖。
 */
const FIELDS: readonly FieldSpec[] = [
  { path: ['browser'], label: '浏览器连接模式', hint: 'managed = 插件启动独立浏览器；attach = 连接外部 CDP 浏览器。', kind: 'select', options: ['managed', 'attach'] },
  { path: ['channel'], label: '独立浏览器类型', hint: '仅 managed 模式生效；使用已安装的真实 Edge 或 Chrome。', kind: 'select', options: ['msedge', 'chrome'] },
  { path: ['profileDir'], label: '独立浏览器 profile', hint: '留空使用 %LOCALAPPDATA%\\DshDeepSeekWeb\\edge-profile。', kind: 'text' },
  { path: ['review', 'enabled'], label: '启用审核', hint: '交付前用审核器复核最终正文；中间工具轮次不审。', kind: 'boolean' },
  { path: ['review', 'provider'], label: '审核器', hint: '独立窗口审核（Kimi / GLM）需要对应浏览器已登录。', kind: 'select', options: ['deepseek-web', 'kimi', 'glm'] },
  { path: ['review', 'maxRounds'], label: '单任务审核轮数', hint: '未通过时回注意见修正，最多这么多轮。', kind: 'number', min: 0, max: 10 },

  { path: ['model'], label: '网页版模型入口', kind: 'select', options: ['deepseek-web', 'deepseek-web-auto'] },
  { path: ['sendMode'], label: '发送模式', hint: 'manual = 每条消息填入后由你点击发送；approved 为预留。', kind: 'select', options: ['manual', 'approved'] },
  { path: ['liveThinking'], label: '显示网页思考过程', hint: '默认关闭，只返回最终正文或工具调用；开启后展示网页真实思考，不重复展示正文。此设置不改变网页的思考模式。', kind: 'boolean' },

  { path: ['rateLimit', 'enabled'], label: '频控自动重发', hint: '网页提示「发送过于频繁」时等待后自动重发同一条。', kind: 'boolean' },
  { path: ['rateLimit', 'retryDelayMs'], label: '重发等待（毫秒）', kind: 'number', min: 1000 },
  { path: ['rateLimit', 'maxRetries'], label: '单轮最大重发次数', kind: 'number', min: 0, max: 20 },

  { path: ['toolAllowlist'], label: '工具白名单', hint: '每行一个；支持 `mcp__xxx__*` 前缀通配。留空表示不限制。', kind: 'list' },
  { path: ['excludeToolNames'], label: '工具排除名单', hint: '每行一个；在白名单之后生效。', kind: 'list' },
  { path: ['delegatedTools'], label: '委托工具', hint: '每行一个；只写进提示词交给网页端自带能力，不在本地执行。', kind: 'list' },

  { path: ['focus', 'enabled'], label: '窗口自动聚焦', kind: 'boolean' },
  { path: ['focus', 'webWindow'], label: '　└ 填入时聚焦网页窗口', kind: 'boolean' },
  { path: ['focus', 'dshWindow'], label: '　└ 回合结束时聚焦 dsh 窗口', kind: 'boolean' },

  { path: ['protocolEveryRequest'], label: '每轮都注入协议', hint: '开启后每条消息都带完整控制协议；代价是提示词更长。', kind: 'boolean' },
  { path: ['protocolRefreshEvery'], label: '协议刷新间隔（轮）', hint: '未开启「每轮都注入」时，每隔这么多轮重新注入一次控制协议快照。', kind: 'number', min: 1 },
  { path: ['maxToolResultChars'], label: '工具结果输入上限（字符）', hint: '只限制送入网页模型的工具结果；最终正文和网页委托结果完整展示。', kind: 'number', min: 256 },
  { path: ['url'], label: 'DeepSeek 网页地址', kind: 'text' },
  { path: ['debugPort'], label: 'CDP 调试端口', hint: 'attach 模式使用此端口；managed 模式把它作为首选端口，冲突时自动选择空闲端口。', kind: 'number', min: 1024, max: 65535 },
]

/** 按路径读取嵌套值；任一段缺失返回 undefined。 */
function readPath(source: unknown, path: FieldPath): unknown {
  let node: unknown = source
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** 把列表字段的草稿写回数组。 */
function parseList(raw: string): string[] {
  return raw.split('\n').map(line => line.trim()).filter(Boolean)
}

/** 是否相等（配置值都是 JSON 形状，按序列化比较足够）。 */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

const labelStyle = { display: 'block', fontSize: 13, lineHeight: '20px', marginBottom: 4 } as const
const hintStyle = { fontSize: 12, lineHeight: '18px', opacity: 0.7, margin: '2px 0 0' } as const
const rowStyle = { marginBottom: 14, maxWidth: 560 } as const
const inputStyle = { font: 'inherit', padding: '6px 8px', width: '100%', boxSizing: 'border-box' } as const

/**
 * 渲染本插件的配置页。
 *
 * @param props - 槽位宿主传入的 `view` 与页面表单句柄。
 * @returns `summary` 为卡片一行说明；`page` 为可编辑表单。
 */
export function DeepSeekWebConfigPage({ view, form }: PluginConfigViewProps): JSX.Element {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  if (view === 'summary') {
    return <>审核通道、网页版模型入口、工具白名单、频控与窗口聚焦。</>
  }

  const accepted = (form?.state.value ?? {}) as Record<string, unknown>
  const revision = form?.state.revision
  const writable = form?.state.writable === true && form?.state.mode === 'host'
  const current = draft ?? accepted

  /** 暂存一次字段修改。 */
  const edit = (path: FieldPath, value: unknown): void => {
    setNotice(null)
    setDraft(previous => {
      const next: Record<string, unknown> = { ...(previous ?? accepted) }
      let node = next
      for (const key of path.slice(0, -1)) {
        const existing = node[key]
        const child = existing !== null && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}
        node[key] = child
        node = child
      }
      node[path[path.length - 1]!] = value
      return next
    })
  }

  /** 提交与本页字段相关的全部改动。 */
  const save = async (): Promise<void> => {
    if (!form || draft === null) return
    const ops = FIELDS.flatMap((field) => {
      const next = readPath(draft, field.path)
      const previous = readPath(accepted, field.path)
      if (sameValue(next, previous)) return []
      return [{ op: 'set' as const, path: [...field.path], value: (next ?? null) as never }]
    })
    if (ops.length === 0) {
      setNotice('没有改动。')
      return
    }
    setBusy(true)
    try {
      const ok = await form.mutate(ops, revision)
      setNotice(ok ? '已保存。' : '保存被宿主拒绝，已恢复宿主值。')
      if (ok) setDraft(null)
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (form === undefined) {
    return (
      <div>
        <p style={hintStyle}>宿主未提供该条目的配置句柄，无法在此编辑。</p>
        <p style={hintStyle}>
          宿主的 <code>formFor()</code> 只在 <code>settings.describe().namespaces</code>
          含 <code>ns === &apos;{ROW_ENTRY_ID}&apos;</code> 时给出表单，而该清单只收录
          Config 里标了 <code>.volatile()</code> 的字段所在的条目。
          若此提示仍出现，请确认该 entry 的 id、以及其字段是否都标了 <code>.volatile()</code>；
          亦可改走 profile 的 <code>cordis.patch.yml</code> 覆盖 <code>config</code>。
        </p>
      </div>
    )
  }

  return (
    <div>
      {!writable && (
        <p style={{ ...hintStyle, marginBottom: 12 }}>
          当前部署不接受写入（只读或非 Host 持久化），字段仅供参考；请改用 profile 的 cordis.patch.yml。
        </p>
      )}

      {FIELDS.map((field) => {
        const value = readPath(current, field.path)
        const id = field.path.join('.')
        return (
          <div key={id} style={rowStyle}>
            <label style={labelStyle} htmlFor={id}>{field.label}</label>
            {field.kind === 'boolean' && (
              <input
                id={id}
                type="checkbox"
                disabled={!writable}
                checked={value === true}
                onChange={event => edit(field.path, event.target.checked)}
              />
            )}
            {field.kind === 'select' && (
              <select
                id={id}
                style={inputStyle}
                disabled={!writable}
                value={typeof value === 'string' ? value : ''}
                onChange={event => edit(field.path, event.target.value)}
              >
                {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            )}
            {field.kind === 'number' && (
              <input
                id={id}
                type="number"
                style={inputStyle}
                disabled={!writable}
                min={field.min}
                max={field.max}
                value={typeof value === 'number' ? String(value) : ''}
                onChange={(event) => {
                  const raw = event.target.value
                  edit(field.path, raw === '' ? undefined : Number(raw))
                }}
              />
            )}
            {field.kind === 'text' && (
              <input
                id={id}
                type="text"
                style={inputStyle}
                disabled={!writable}
                value={typeof value === 'string' ? value : ''}
                onChange={event => edit(field.path, event.target.value)}
              />
            )}
            {field.kind === 'list' && (
              <textarea
                id={id}
                style={{ ...inputStyle, minHeight: 88, fontFamily: 'monospace' }}
                disabled={!writable}
                value={Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : ''}
                onChange={event => edit(field.path, parseList(event.target.value))}
              />
            )}
            {field.hint !== undefined && <p style={hintStyle}>{field.hint}</p>}
          </div>
        )
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <button type="button" disabled={!writable || busy || draft === null} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" disabled={busy || draft === null} onClick={() => { setDraft(null); setNotice(null) }}>
          放弃修改
        </button>
        {notice !== null && <span style={hintStyle}>{notice}</span>}
      </div>
    </div>
  )
}
