/** Chinese configuration page for the host-owned, revisioned settings form. */
import { useId, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { CONFIG_FIELDS, draftErrors, draftOperations, editConfig, fieldValue, type ConfigDraft } from './config-form.ts'
import { CONFIG_PAGE_STYLE } from './config-page-style.ts'

export const PACKAGE_NAME = 'dsh-deepseek-web-littlecar30'
export const ROW_ENTRY_ID = 'llm-deepseek-web'
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ENTRY_ID}`

function Section({ icon, title, description, wide, children }: { icon: string; title: string; description: string; wide?: boolean; children: ReactNode }): JSX.Element {
  return <section className={`dsw-card${wide ? ' dsw-wide' : ''}`}><div className="dsw-section-title"><span className="dsw-icon" aria-hidden="true">{icon}</span><div><h3>{title}</h3><p>{description}</p></div></div>{children}</section>
}

export function DeepSeekWebConfigPage({ view, form }: PluginConfigViewProps): JSX.Element {
  type Revision = NonNullable<PluginConfigViewProps['form']>['state']['revision']
  const instanceId = useId()
  const [draft, setDraft] = useState<ConfigDraft<Revision> | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  if (view === 'summary') return <>选择发送方式、浏览器与审核通道，管理工具和重试偏好。</>

  const accepted = form?.state.value ?? {}
  const revision = form?.state.revision
  // The host's ConfigForm reports readiness and write permission; newer DSH
  // versions no longer include the old connection mode field.
  const writable = form?.state.writable === true && form.state.status === 'ready'
  const accessLabel = form?.state.status === 'ready' ? writable ? '设置可编辑' : '当前为只读' : form?.state.status === 'loading' ? '正在读取' : '配置不可用'
  const conflict = draft !== null && draft.revision !== revision
  const errors = draftErrors(draft)
  const changes = draftOperations(draft)
  const invalid = Object.keys(errors).length > 0
  const value = (key: string): unknown => {
    const field = CONFIG_FIELDS.find(field => field.key === key)!
    return draft && Object.hasOwn(draft.edits, key) ? draft.edits[key] : fieldValue(draft?.base ?? accepted, field)
  }
  const edit = (key: string, next: unknown): void => {
    if (!writable || busy) return
    setNotice(null)
    setDraft(previous => editConfig(previous, accepted, form!.state.revision, key, next))
  }
  const reset = (): void => { setDraft(null); setNotice(null) }
  const save = async (): Promise<void> => {
    if (!form || !draft || !writable || busy || invalid || conflict || changes.length === 0) return
    setBusy(true)
    setNotice(null)
    try {
      const ok = await form.mutate(changes, draft.revision)
      if (ok) { setDraft(null); setNotice('已保存。连接设置需重启 dsh 后生效。') }
      else setNotice('宿主未接受修改。草稿已保留，请检查配置或重新载入。')
    } catch (error) {
      setNotice(`保存失败，草稿已保留：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  const renderField = (key: string): JSX.Element => {
    const field = CONFIG_FIELDS.find(field => field.key === key)!
    const current = value(key)
    const id = `${instanceId}-${key}`
    const error = errors[key]
    const disabled = !writable || busy
    const hint = field.hint && <p className="dsw-hint" id={`${id}-hint`}>{field.hint}</p>
    const describedBy = [field.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
    let control: ReactNode
    if (field.kind === 'boolean') {
      return <div className="dsw-field dsw-toggle-row" key={key}><div className="dsw-toggle-copy"><label className="dsw-label" htmlFor={id}>{field.label}</label>{hint}</div><button id={id} type="button" role="switch" aria-checked={current === true} aria-describedby={describedBy} aria-label={field.label} className="dsw-toggle" disabled={disabled} onClick={() => edit(key, current !== true)}><span /></button></div>
    }
    if (field.kind === 'choice') {
      control = <div className="dsw-choice-grid" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>{field.options?.map(option => <button key={option.value} type="button" className="dsw-choice" aria-pressed={current === option.value} disabled={disabled} onClick={() => edit(key, option.value)}><span className="dsw-choice-title">{option.label}<span className="dsw-choice-check" aria-hidden="true">{current === option.value ? '✓' : ''}</span></span>{option.hint && <span className="dsw-choice-hint">{option.hint}</span>}</button>)}</div>
    } else if (field.kind === 'number') {
      const numeric = Number(current)
      const step = key.endsWith('Ms') ? 1000 : key === 'maxToolResultChars' ? 1000 : 1
      control = <div className="dsw-number"><button type="button" className="dsw-step" aria-label={`减少${field.label}`} disabled={disabled || !Number.isFinite(numeric) || numeric <= (field.min ?? -Infinity)} onClick={() => edit(key, Math.max(field.min ?? -Infinity, numeric - step))}>−</button><input id={id} className="dsw-input" type="number" inputMode="numeric" step={1} min={field.min} max={field.max} value={String(current ?? '')} aria-describedby={describedBy} aria-invalid={Boolean(error)} disabled={disabled} onChange={event => edit(key, event.target.value)} /><button type="button" className="dsw-step" aria-label={`增加${field.label}`} disabled={disabled || !Number.isFinite(numeric) || numeric >= (field.max ?? Infinity)} onClick={() => edit(key, Math.min(field.max ?? Infinity, numeric + step))}>+</button>{field.unit && <span className="dsw-unit">{field.unit}</span>}</div>
    } else if (field.kind === 'list') {
      const raw = Array.isArray(current) ? current.join('\n') : String(current ?? '')
      const items = raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      control = <><div className="dsw-chips">{items.length ? items.map((item, index) => <span className="dsw-chip" key={`${item}-${index}`}>{item}</span>) : <span className="dsw-hint">{key === 'toolAllowlist' ? '全部宿主工具' : '未设置'}</span>}</div>{key === 'toolAllowlist' && <button type="button" className="dsw-link" disabled={disabled || items.length === 0} onClick={() => edit(key, [])}>使用宿主全部工具</button>}<details className="dsw-list-editor"><summary>编辑工具列表</summary><label className="dsw-hint" htmlFor={id}>每行一个工具名称</label><textarea id={id} className="dsw-input" value={raw} disabled={disabled} aria-describedby={describedBy} spellCheck={false} onChange={event => edit(key, event.target.value)} /></details></>
    } else {
      control = <input id={id} className="dsw-input" type={key === 'url' ? 'url' : 'text'} value={String(current ?? '')} placeholder={key === 'profileDir' ? '使用默认数据目录' : undefined} disabled={disabled} spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={event => edit(key, event.target.value)} />
    }
    return <div className="dsw-field" key={key}>{field.kind === 'choice' ? <span className="dsw-label" id={`${id}-label`}>{field.label}</span> : <label className="dsw-label" htmlFor={id}>{field.label}</label>}{control}{hint}{error && <p className="dsw-error" id={`${id}-error`} role="alert">{error}</p>}</div>
  }

  return <div className={`dsw-settings${writable ? '' : ' dsw-readonly'}`}><style>{CONFIG_PAGE_STYLE}</style>
    <header className="dsw-heading"><div><p className="dsw-eyebrow">DEEPSEEK WEB</p><h2>让网页配合你的工作方式</h2><p>连接已登录的浏览器，使用 dsh 的任务与工具。</p></div><span className="dsw-badge"><span className="dsw-dot" />{accessLabel}</span></header>
    {!form || form.state.status === 'unavailable' ? <div className="dsw-alert">暂时无法读取配置。请确认插件已启用，并重新打开此页面。</div> : form.state.status !== 'ready' ? <div className="dsw-alert">正在读取设置，请稍候。</div> : !writable && <div className="dsw-alert">DSH 将此配置标记为只读，当前无法保存修改。</div>}
    {conflict && <div className="dsw-alert" role="alert">设置已在其他位置更新。请先重新载入，再编辑和保存。<button type="button" disabled={busy} onClick={reset}>重新载入并放弃草稿</button></div>}
    <div className="dsw-layout">
      <Section icon="↗" title="发送与显示" description="决定每轮消息如何发出" wide>{renderField('sendMode')}<div className="dsw-divider" />{renderField('liveThinking')}{renderField('compactionLanguage')}</Section>
      <Section icon="▣" title="浏览器连接" description="在熟悉的浏览器里继续工作">{renderField('browser')}{value('browser') === 'managed' ? renderField('channel') : <p className="dsw-empty">请先启动开启远程调试的浏览器，并在高级设置中填写对应端口。</p>}</Section>
      <Section icon="✓" title="交付审核" description="在最终结果交付前，再检查一次">{renderField('review.enabled')}{value('review.enabled') === true ? <div className="dsw-subsection">{renderField('review.provider')}{renderField('review.maxRounds')}</div> : <p className="dsw-empty">审核已关闭，网页结果将直接交付。</p>}</Section>
      <Section icon="↻" title="发送重试" description="遇到短暂频控，自动稍后再试">{renderField('rateLimit.enabled')}{value('rateLimit.enabled') === true && <div className="dsw-subsection">{renderField('rateLimit.retryDelayMs')}{renderField('rateLimit.maxRetries')}</div>}</Section>
      <Section icon="⇄" title="窗口切换" description="在网页和 dsh 之间自然衔接">{renderField('focus.enabled')}{value('focus.enabled') === true && <div className="dsw-subsection">{renderField('focus.webWindow')}{renderField('focus.dshWindow')}</div>}</Section>
      <Section icon="⌘" title="工具范围" description="选择网页模型可以调用的宿主工具，仍遵循 dsh 权限与审批" wide><div className="dsw-tools"><div>{renderField('toolAllowlist')}</div><div>{renderField('excludeToolNames')}{renderField('delegatedTools')}</div></div></Section>
      <details className="dsw-advanced"><summary>高级设置<span>连接地址、数据目录和长任务参数</span></summary><div className="dsw-advanced-body"><div>{renderField('url')}{renderField('profileDir')}{renderField('debugPort')}</div><div>{renderField('protocolEveryRequest')}{value('protocolEveryRequest') !== true && renderField('protocolRefreshEvery')}{renderField('maxToolResultChars')}</div></div></details>
    </div>
    <footer className="dsw-footer"><div className="dsw-footer-status" role="status" aria-live="polite">{notice ?? (invalid ? '请修正标红的字段后保存。' : conflict ? '设置有更新，请重新载入。' : changes.length > 0 ? `${changes.length} 项修改尚未保存` : '仅点击保存后生效')}</div><div className="dsw-footer-actions"><button type="button" className="dsw-button" disabled={!draft || busy} onClick={reset}>放弃修改</button><button type="button" className="dsw-button dsw-primary" disabled={!writable || busy || invalid || conflict || changes.length === 0} onClick={() => { void save() }}>{busy ? '保存中…' : '保存设置'}</button></div></footer>
  </div>
}
