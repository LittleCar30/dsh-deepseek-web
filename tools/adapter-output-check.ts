/** 离线回归：默认只返回结果、思考不混入正文、长委托不丢结论、工具输入仍有上限。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import type { BrowserChannel, BrowserTurnRequest, BrowserTurnResult } from '../src/browser-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { toolResultToWebMessage } from '../src/protocol.ts'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-web-output-'))
const options = (id: string): GenerateOptions => ({
  sessionId: id,
  model: 'deepseek-web-auto',
  messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '请给出结果' }] }],
  tools: [{ name: 'read', description: '读取文件', parameters: {
    type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
  } }],
} as unknown as GenerateOptions)

class ScriptedChannel implements BrowserChannel {
  calls = 0
  constructor(private readonly replies: BrowserTurnResult[]) {}
  async ensureReady(): Promise<void> {}
  resetConversationGate(): void {}
  async status(): Promise<{ ready: boolean }> { return { ready: true } }
  async focusBrowser(): Promise<void> {}
  async focusHarness(): Promise<void> {}
  async dispose(): Promise<void> {}
  async turn(request: BrowserTurnRequest): Promise<BrowserTurnResult> {
    const reply = this.replies[this.calls++]
    assert.ok(reply, 'unexpected extra browser turn')
    // 覆盖正文单独到达、思考单独到达、二者同时到达三种回调。
    request.onProgress?.({ text: reply.text.slice(0, 1), reasoning: '' })
    if (reply.reasoning) request.onProgress?.({ text: '', reasoning: reply.reasoning.slice(0, 1) })
    request.onProgress?.({ text: reply.text.slice(1), reasoning: reply.reasoning?.slice(1) ?? '' })
    return reply
  }
}

async function run(id: string, replies: BrowserTurnResult[], liveThinking?: boolean) {
  const config = liveConfig(Config({
    stateFile: path.join(tempDir, `${id}.json`),
    ...(liveThinking === undefined ? {} : { liveThinking }),
    autoCorrectMalformed: false,
    focus: { enabled: false },
  }))
  const channel = new ScriptedChannel(replies)
  const adapter = new DeepSeekWebAdapter(config, channel)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options(id))) chunks.push(chunk)
  const ended = chunks.filter(chunk => chunk.type === 'block-end')
  const blocks = ended.map(chunk => chunk.block)
  const indexes = chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)
  assert.equal(new Set(indexes).size, indexes.length, 'content block indexes must be unique')
  for (const end of ended) {
    if (end.block.type !== 'reasoning') continue
    const streamed = chunks.filter(chunk => chunk.type === 'reasoning-delta' && chunk.index === end.index)
      .map(chunk => chunk.text).join('')
    assert.equal(streamed, end.block.text, 'streamed reasoning must match the final block')
  }
  assert.equal(channel.calls, replies.length)
  assert.equal(chunks.at(-1)?.type, 'finish')
  return { config, chunks, blocks }
}

try {
  const answer = '最终回答'
  const reasoning = '真实思考'.repeat(5_000)
  const hidden = await run('default', [{ text: answer, reasoning }])
  assert.equal(hidden.config.liveThinking, false)
  assert.deepEqual(hidden.blocks, [{ type: 'text', text: answer }])
  assert.ok(!hidden.chunks.some(chunk => chunk.type === 'reasoning-delta'))

  const explicitOff = await run('explicit-off', [{ text: answer, reasoning }], false)
  assert.deepEqual(explicitOff.blocks, hidden.blocks)

  const shown = await run('thinking-on', [{ text: answer, reasoning }], true)
  assert.deepEqual(shown.blocks, [{ type: 'reasoning', text: reasoning }, { type: 'text', text: answer }])
  assert.ok(!shown.chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text.includes(answer)))

  const textOnly = await run('text-only', [{ text: answer }], true)
  assert.deepEqual(textOnly.blocks, [{ type: 'text', text: answer }])

  const delegate = JSON.stringify({ actions: [
    { tool: 'web_search', arguments: { query: 'test' } },
    { tool: 'web_fetch', arguments: { url: 'https://example.com' } },
  ] })
  const longAnswer = '结果'.repeat(6_000) + '\n最终结论：完整保留末尾。'
  for (const liveThinking of [false, true]) {
    const result = await run(`delegated-${liveThinking}`, [
      { text: delegate },
      { text: longAnswer, reasoning },
      { text: '页面摘要与来源', reasoning: '阅读页面' },
    ], liveThinking)
    const expected = `[web_search 委托结果]\n${longAnswer}\n\n[web_fetch 委托结果]\n页面摘要与来源`
    assert.deepEqual(result.blocks.filter(block => block.type === 'text'), [{ type: 'text', text: expected }])
    assert.ok(!result.chunks.some(chunk => chunk.type === 'tool-call-delta'))
    assert.deepEqual(result.blocks.filter(block => block.type === 'reasoning'), liveThinking
      ? [{ type: 'reasoning', text: reasoning }, { type: 'reasoning', text: '阅读页面' }]
      : [])
  }

  const localAction = JSON.stringify({ actions: [{ tool: 'read', arguments: { file_path: 'a.txt' } }] })
  const local = await run('local-tool', [{ text: localAction, reasoning }])
  assert.ok(local.chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'read'))
  assert.ok(!local.blocks.some(block => block.type === 'text' || block.type === 'reasoning'))

  const clamped = toolResultToWebMessage(undefined, {
    role: 'tool', content: [{ type: 'text', text: longAnswer }],
  } as Parameters<typeof toolResultToWebMessage>[1], 6_000)
  assert.ok(clamped.includes('工具输出过长，已截断'))
  assert.ok(clamped.endsWith('最终结论：完整保留末尾。'))
  assert.ok(clamped.length < longAnswer.length)
  console.log('OK: 默认隐藏思考、真实思考独立展示、长委托完整交付、本地工具调用与工具输入限制正常')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
