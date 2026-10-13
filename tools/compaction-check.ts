/** 摘要生命周期回归：隔离调用、状态保护、压缩恢复、浏览器页面和取消。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { PlaywrightBrowserChannel, parseCompletionBody } from '../src/playwright-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { buildAuxiliaryPrompt, renderNewWebMessages } from '../src/protocol.ts'
import { looksLikeUnfinishedHandoff } from '../src/response.ts'
import { AsyncLock } from '../src/async-lock.ts'

const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-compaction-check-'))
const directive = 'You are now acting as a compaction engine. Condense the conversation ABOVE into a structured checkpoint. Write concise English engineering prose. Output only the checkpoint text: do not call any tool or take any other action.'
const goal = '请检查文档，生成中文流程包并保存文件'
const user = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: goal }] }
const summary = '- User asked (in Chinese): generate a workflow package.\n- User wants: Chinese files.\n- Prior assistant delivered: a plan.\n- ZIP NOT yet inventoried.\n- Pending jobs: write the files.'
const checkpoint = (id: string) => ({ id, role: 'user', source: { kind: 'compact-checkpoint', compactionId: id },
  content: [{ type: 'text', text: `<compacted-summary>\n${summary}\n</compacted-summary>` }] })
const toolCall = { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [
  { type: 'text', text: '正在读取文档' },
  { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"input.txt"}' },
] }
const result = { id: 't1', role: 'tool', content: [{ type: 'text', text: '文档内容：复用已完成工作，更新检索式' }] }
const options = (messages: unknown[], extra = {}) => ({ provider: 'deepseek-web', model: 'deepseek-web-auto',
  sessionId: 'task', messages, tools: [{ name: 'read', description: '读文件', parameters: { type: 'object',
    properties: { file_path: { type: 'string' } }, required: ['file_path'] } }], ...extra } as GenerateOptions)
const body = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'block-end' && c.block.type === 'text')
  .map(c => c.type === 'block-end' && c.block.type === 'text' ? c.block.text : '').join('')
async function consume(adapter: DeepSeekWebAdapter, request: GenerateOptions) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}
class Channel implements BrowserChannel {
  isConversationActive?: (sessionId: string) => boolean
  ordinary: BrowserTurnRequest[] = []
  isolated: BrowserTurnRequest[] = []
  resets = 0
  response: BrowserTurnResult = { text: '中文流程包已保存' }
  auxiliary: BrowserTurnResult = { text: summary }
  auxiliaryError?: Error
  async ensureReady() {}
  resetConversationGate() { this.resets++ }
  async status() { return { ready: true } }
  async focusBrowser() {}
  async focusHarness() {}
  async dispose() {}
  async turn(request: BrowserTurnRequest) { this.ordinary.push(request); return this.response }
  async turnIsolated(request: BrowserTurnRequest) {
    this.isolated.push(request)
    if (this.auxiliaryError) throw this.auxiliaryError
    return this.auxiliary
  }
}

try {
  const stateFile = path.join(dir, 'state.json')
  const config = liveConfig(Config({ stateFile, liveThinking: true, focus: { enabled: false }, review: { enabled: true } }))
  const channel = new Channel()
  let reviews = 0
  const reviewer = { needsEvidence: true, review: async () => {
    reviews++; return { ok: true, issues: [], suggestions: [], raw: '{}' }
  } }
  const adapter = new DeepSeekWebAdapter(config, channel, reviewer)
  await consume(adapter, options([user]))
  const ordinaryState = async () => JSON.parse(await readFile(stateFile, 'utf8')).task
  const before = await ordinaryState()
  const reviewBefore = reviews
  for (const purpose of ['compaction', 'session-title'] as const) {
    const chunks = await consume(adapter, options([user, toolCall, result,
      { role: 'user', content: [{ type: 'text', text: directive }] }], { purpose }))
    assert.equal(body(chunks), summary)
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.ok(!chunks.some(c => c.type === 'tool-call-delta' || c.type === 'reasoning-delta'))
    assert.deepEqual(await ordinaryState(), before)
  }
  assert.equal(reviews, reviewBefore, '内部请求不能进入交付审核')
  assert.equal(channel.ordinary.length, 1)
  assert.ok(channel.isolated[0]!.text.includes('input.txt') && channel.isolated[0]!.text.includes('文档内容'))
  assert.ok(!channel.isolated[0]!.text.includes('你是一个 Agent 指令引擎'))
  // 等待中的普通请求必须排在内部调用之后，取消也不能污染普通状态。
  const originalIsolated = channel.turnIsolated.bind(channel)
  let enterAux!: () => void
  const enteredAux = new Promise<void>(resolve => { enterAux = resolve })
  let releaseAux!: () => void
  const blockedAux = new Promise<void>(resolve => { releaseAux = resolve })
  channel.turnIsolated = async request => { enterAux(); await blockedAux; return originalIsolated(request) }
  const inFlightAbort = new AbortController()
  const auxiliaryRun = consume(adapter, options([user, { role: 'user', content: [{ type: 'text', text: directive }] }],
    { purpose: 'compaction', signal: inFlightAbort.signal }))
  const rejectedAux = assert.rejects(auxiliaryRun)
  await enteredAux
  const ordinaryCount = channel.ordinary.length
  const queuedNormal = consume(adapter, options([user, toolCall, result]))
  await Promise.resolve()
  assert.equal(channel.ordinary.length, ordinaryCount)
  inFlightAbort.abort(); releaseAux(); await rejectedAux
  await queuedNormal
  channel.turnIsolated = originalIsolated
  const stable = await ordinaryState()
  // 后续比较均以成功的正常请求为基准。
  Object.assign(before, stable)

  // 摘要包含动作 JSON 时只能当文本；明确截断由宿主拒绝提交。
  channel.auxiliary = { text: '{"actions":[{"tool":"read","arguments":{"file_path":"x"}}]}', finishReason: 'max-tokens' }
  const capped = await consume(adapter, options([{ role: 'user', content: [{ type: 'text', text: directive }] }], { purpose: 'compaction' }))
  assert.ok(!capped.some(c => c.type === 'tool-call-delta'))
  assert.deepEqual(capped.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.deepEqual(await ordinaryState(), before)
  channel.auxiliaryError = new Error('summary failed')
  await assert.rejects(consume(adapter, options([user, { role: 'user', content: [{ type: 'text', text: directive }] }], { purpose: 'compaction' })), /summary failed/)
  assert.deepEqual(await ordinaryState(), before)
  channel.auxiliaryError = undefined
  channel.auxiliary = { text: summary }
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(consume(adapter, options([user], { purpose: 'compaction', signal: cancelled.signal })))
  assert.deepEqual(await ordinaryState(), before)

  const resumed = [checkpoint('cp1'), toolCall, result]
  await consume(adapter, options(resumed))
  const prompt = channel.ordinary.at(-1)!
  assert.equal(prompt.initialize, true)
  assert.ok(prompt.text.includes('<compacted-summary>') && prompt.text.includes('历史助手回复'))
  assert.ok(prompt.text.includes('input.txt') && prompt.text.includes('文档内容'))
  assert.ok(prompt.text.includes(goal) && !prompt.text.includes(directive))
  assert.equal((await ordinaryState()).goalText, goal)
  await consume(adapter, options([...resumed, { ...result, id: 't2' }]))
  assert.equal(channel.ordinary.at(-1)!.initialize, false)
  await consume(adapter, options([checkpoint('cp2'), toolCall, result]))
  assert.equal(channel.ordinary.at(-1)!.initialize, true, '第二次压缩必须同步新检查点')

  // 旧版污染恢复，以及原任务已被压缩移除时依据检查点继续。
  const legacyFile = path.join(dir, 'legacy.json')
  await writeFile(legacyFile, JSON.stringify({ task: { initialized: true, goalText: directive, lastMessageId: 'gone', reviewRoundsUsed: 0 } }))
  const legacyChannel = new Channel()
  const legacy = new DeepSeekWebAdapter(liveConfig(Config({ stateFile: legacyFile, focus: { enabled: false } })), legacyChannel)
  await consume(legacy, options([checkpoint('cp1'), result]))
  const legacyState = JSON.parse(await readFile(legacyFile, 'utf8')).task
  assert.equal(legacyState.goalText, undefined)
  assert.ok(legacyChannel.ordinary[0]!.text.includes('[任务接续]'))
  assert.ok(!legacyChannel.ordinary[0]!.text.includes(directive))
  // 重启后缺少网页归属证据时强制回放。
  legacyChannel.isConversationActive = () => false
  const restarted = new DeepSeekWebAdapter(liveConfig(Config({ stateFile: legacyFile })), legacyChannel)
  await consume(restarted, options([checkpoint('cp1'), result]))
  assert.equal(legacyChannel.ordinary.at(-1)!.initialize, true)

  const renderState = { initialized: false, roundsSinceProtocol: 0, lastParseOk: true, reviewRoundsUsed: 0 }
  const context = { id: 'ctx', role: 'user', source: { kind: 'plugin', plugin: 'workspace', form: 'instructions' }, content: [{ type: 'text', text: '工作区规则' }] }
  const rendered = renderNewWebMessages(options([user, context], { system: '系统规则' }), renderState, config)!
  assert.ok(rendered.prompt.text.includes('工作区规则') && rendered.prompt.text.includes('系统规则'))
  assert.equal((renderState as any).goalText, goal)
  const scoped = buildAuxiliaryPrompt(options([context, toolCall, result,
    { role: 'user', content: [{ type: 'text', text: directive }] }], { purpose: 'compaction' }))
  assert.ok(!scoped.includes(goal), '不能偷用主网页中范围之外的历史')
  const titleRequest = options([{ id: 'title-1', role: 'user', source: { kind: 'dsh-session-title-llm' },
    content: [{ type: 'text', text: '给这个用户任务起标题：修订中文流程包' }] }],
  { purpose: 'session-title', system: '只返回一个中文会话标题' })
  assert.ok(buildAuxiliaryPrompt(titleRequest).includes('[辅助系统指令]\n只返回一个中文会话标题'))
  channel.auxiliary = { text: '修订中文流程包' }
  assert.equal(body(await consume(adapter, titleRequest)), '修订中文流程包')

  // 交接摘要自动恢复一轮，仍未交付则显式失败；真正请求摘要时正常返回。
  const repairChannel = new Channel()
  let rounds = 0
  repairChannel.turn = async request => { repairChannel.ordinary.push(request); return { text: rounds++ === 0 ? summary : '中文流程包已保存' } }
  const repair = new DeepSeekWebAdapter(liveConfig(Config({ stateFile: path.join(dir, 'repair.json'), focus: { enabled: false } })), repairChannel)
  assert.equal(body(await consume(repair, options([user]))), '中文流程包已保存')
  assert.equal(repairChannel.ordinary.length, 2)
  repairChannel.response = { text: summary }
  repairChannel.turn = async request => { repairChannel.ordinary.push(request); return repairChannel.response }
  await assert.rejects(consume(repair, options([{ ...user, id: 'u2' }])), /未完成的任务交接摘要/)
  const repairState = JSON.parse(await readFile(path.join(dir, 'repair.json'), 'utf8')).task
  for (const finishReason of ['max-tokens', 'interrupted'] as const) {
    repairChannel.response = { text: '未完成正文', finishReason }
    await assert.rejects(consume(repair, options([{ ...user, id: 'u2' }])))
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'repair.json'), 'utf8')).task, repairState)
  }
  assert.equal(looksLikeUnfinishedHandoff(summary, '请总结这段对话'), false)
  assert.equal(looksLikeUnfinishedHandoff('English deliverable with all files saved.', goal), false)

  // browser 层：临时页面真正独立，正常页面归属/闸门不变；失败和取消都会清理。
  const browser = new PlaywrightBrowserChannel({ config }) as any
  const mainPage = { isClosed: () => false }
  let closed = 0
  browser.page = mainPage; browser.activeSessionId = 'task'; browser.conversationStarted = true
  browser.ensureReady = async () => {}
  browser.startFreshConversation = async (page: unknown) => { assert.notEqual(page, mainPage) }
  browser.context = { newPage: async () => ({ goto: async () => {}, close: async () => { closed++ } }) }
  let fail = false
  browser.turnOnPage = async (page: unknown, request: BrowserTurnRequest) => {
    assert.notEqual(page, mainPage)
    if (fail) throw new Error('isolated failure')
    request.signal?.throwIfAborted()
    return { text: summary }
  }
  const isolated = { sessionId: 'task', model: 'deepseek-web-auto', text: 'summary', initialize: true, autoSend: true }
  await browser.turnIsolated(isolated)
  fail = true
  await assert.rejects(browser.turnIsolated(isolated), /isolated failure/)
  fail = false
  const midAbort = new AbortController()
  browser.turnOnPage = async () => { midAbort.abort(); midAbort.signal.throwIfAborted() }
  await assert.rejects(browser.turnIsolated({ ...isolated, signal: midAbort.signal }))
  assert.equal(closed, 3)
  assert.equal(browser.page, mainPage)
  assert.equal(browser.activeSessionId, 'task')
  assert.equal(browser.conversationStarted, true)

  const lock = new AsyncLock(); const release = await lock.acquire()
  const queuedAbort = new AbortController()
  const pending = lock.acquire(queuedAbort.signal); queuedAbort.abort()
  await assert.rejects(pending)
  let entered = false
  const next = lock.acquire().then(unlock => { entered = true; unlock() })
  await Promise.resolve(); assert.equal(entered, false)
  release(); await next; assert.equal(entered, true)

  for (const [raw, expected] of [['length', 'max-tokens'], ['stop', 'stop'], ['aborted', 'interrupted']] as const) {
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' }, finish_reason: raw }] }) + '\n'
    assert.equal(parseCompletionBody(sse).finishReason, expected)
    assert.equal(parseCompletionBody(JSON.stringify({ content: '正文', finish_reason: raw })).finishReason, expected)
  }
  assert.equal(parseCompletionBody('data: {"p":"response","o":"BATCH","v":[{"p":"finish_reason","v":"length"}]}\n').finishReason, 'max-tokens')
  console.log('OK: 辅助请求隔离、状态不污染、压缩接续、旧状态恢复、审核隔离、取消清理与结束原因正常')
} finally {
  await rm(dir, { recursive: true, force: true })
}
