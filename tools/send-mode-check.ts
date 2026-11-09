/** 发送设置必须作用于普通/工具后续/辅助请求，并在运行中读取最新 volatile 值。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { Config, type Config as PluginConfig, type SendMode } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import type { BrowserChannel, BrowserTurnRequest } from '../src/browser-channel.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

class RecordingChannel implements BrowserChannel {
  ordinary: BrowserTurnRequest[] = []
  isolated: BrowserTurnRequest[] = []
  sessionModes = new Map<string, boolean>()
  reply = '测试完成。'
  async ensureReady() {}
  resetConversationGate() {}
  async status() { return { ready: true } }
  async focusBrowser() {}
  async focusHarness() {}
  async dispose() {}
  setSessionAutoSend(session: string, auto: boolean) { this.sessionModes.set(session, auto) }
  async turn(request: BrowserTurnRequest) { this.ordinary.push(request); return { text: this.reply } }
  async turnIsolated(request: BrowserTurnRequest) { this.isolated.push(request); return { text: '辅助正文。' } }
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-send-mode-'))
const tool = { name: 'read', description: '读取测试文件', parameters: { type: 'object',
  properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
const user = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读取测试文件并报告。' }] })
const request = (model: string, messages: unknown[], extra = {}) => ({ provider: 'deepseek-web', model,
  sessionId: 'send-mode', messages, tools: [tool], ...extra }) as GenerateOptions
async function consume(adapter: DeepSeekWebAdapter, options: GenerateOptions) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

try {
  // 明确期望表包含旧 approved 配置；它继续跟随会话选择，不能变成隐式强制自动。
  const cases: Array<{ model: string; mode: SendMode; auto: boolean }> = [
    { model: 'deepseek-web', mode: 'model', auto: false },
    { model: 'deepseek-web', mode: 'manual', auto: false },
    { model: 'deepseek-web', mode: 'auto', auto: true },
    { model: 'deepseek-web', mode: 'approved', auto: false },
    { model: 'deepseek-web-auto', mode: 'model', auto: true },
    { model: 'deepseek-web-auto', mode: 'manual', auto: false },
    { model: 'deepseek-web-auto', mode: 'auto', auto: true },
    { model: 'deepseek-web-auto', mode: 'approved', auto: true },
  ]
  for (const [index, { model, mode, auto }] of cases.entries()) {
    const config = liveConfig(Config({ sendMode: mode, toolAllowlist: [], focus: { enabled: false },
      stateFile: path.join(dir, `${index}.json`) }))
    const channel = new RecordingChannel()
    const adapter = new DeepSeekWebAdapter(config, channel)
    channel.reply = '{"actions":[{"tool":"read","arguments":{"file_path":"fixture.txt"}}]}'
    const first = await consume(adapter, request(model, [user('u1')]))
    assert.equal(first.at(-1)?.type, 'finish')
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.ok(call && call.type === 'block-end' && call.block.type === 'tool-call')
    channel.reply = '测试完成。'
    const history = [user('u1'), { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [call.block] },
      { id: 't1', role: 'tool', source: { kind: 'tool', callId: call.block.id }, toolCallId: call.block.id,
        content: [{ type: 'text', text: '测试文件正文。' }] }]
    await consume(adapter, request(model, history))
    assert.equal(channel.ordinary.length, 2)
    for (const turn of channel.ordinary) assert.equal(turn.autoSend, auto, `${model}/${mode} 普通与工具后续轮次`)
    assert.equal(channel.sessionModes.get('send-mode'), auto)
    assert.equal(channel.sessionModes.get('deepseek-self-review'), auto)
    for (const purpose of ['compaction', 'session-title'] as const) {
      await consume(adapter, request(model, [...history, { role: 'user', content: [{ type: 'text', text: '仅返回辅助正文。' }] }], { purpose }))
      assert.equal(channel.isolated.at(-1)!.autoSend, auto, `${model}/${mode}/${purpose}`)
    }
    assert.equal(channel.isolated.length, 2)
  }

  // 同一个 adapter、同一个模型、同一条 volatile 引用：保存配置后下一轮必须立即生效。
  for (const model of ['deepseek-web', 'deepseek-web-auto']) {
    let latest: SendMode = 'manual'
    const base = Config({ stateFile: path.join(dir, `live-${model}.json`), focus: { enabled: false } })
    const config = liveConfig({ ...base, sendMode: { get: () => latest } } as unknown as PluginConfig)
    const channel = new RecordingChannel()
    const adapter = new DeepSeekWebAdapter(config, channel)
    const history: unknown[] = []
    for (const [index, step] of [
      { mode: 'manual', auto: false }, { mode: 'auto', auto: true },
      { mode: 'manual', auto: false }, { mode: 'model', auto: model === 'deepseek-web-auto' },
    ].entries()) {
      latest = step.mode as SendMode
      history.push(user(`u${index}`))
      await consume(adapter, request(model, history))
      assert.equal(channel.ordinary.at(-1)!.autoSend, step.auto, `${model} 保存后普通轮次读取 ${step.mode}`)
      assert.equal(channel.ordinary.at(-1)!.initialize, index === 0, '修改发送设置无需重建工作对话')
      await consume(adapter, request(model, [user(`aux${index}`)], { purpose: 'compaction' }))
      assert.equal(channel.isolated.at(-1)!.autoSend, step.auto, `${model} 保存后辅助请求读取 ${step.mode}`)
    }
  }
  console.log('OK: 两种模型 × 四种发送设置、工具后续/审核映射/两类辅助请求，以及运行中修改下一轮立即生效')
} finally { await rm(dir, { recursive: true, force: true }) }
