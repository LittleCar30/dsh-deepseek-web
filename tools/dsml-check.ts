/** 回归真实网页 DSML：完整解析、类型校验、禁止半截执行和错误完成。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseWebReply, looksLikeIntendedToolReply, repairAndValidateActions } from '../src/response.ts'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'

const invocation = (name: string, params: string) => `<｜｜DSML｜｜ invoke name="${name}">\n${params}\n</｜｜DSML｜｜ invoke>`
const parameter = (name: string, value: string, string = true) => `<｜｜DSML｜｜ parameter name="${name}" string="${string}">${value}</｜｜DSML｜｜ parameter>`
const calls = (body: string) => `<｜｜DSML｜｜ calls>\n${body}\n</｜｜DSML｜｜ calls>`
const recorded = calls(Array.from({ length: 4 }, (_, i) => invocation('read', [
  parameter('file_path', String.raw`D:\project\小程序\file.js`),
  parameter('offset', String(440 + i * 200), false), parameter('limit', '200', false),
].join('\n'))).join('\n'))
const parsed = parseWebReply(recorded)
assert.equal(looksLikeIntendedToolReply('结果如下：\n```json\n{"actions":[]}\n```'), false)
assert.equal(looksLikeIntendedToolReply('```json\n{"status":"ok"}\n```'), false)
assert.equal(parseWebReply('DSML 是 DeepSeek 的工具协议。').hasActions, false)
assert.equal(parsed.actions.length, 4)
assert.equal(parsed.actions[0]!.params!.offset, 440)
assert.equal(parsed.actions[0]!.params!.file_path, String.raw`D:\project\小程序\file.js`)
const command = 'Get-Content "a.txt"\nWrite-Output "$value"'
assert.equal(parseWebReply(calls(invocation('pwsh', parameter('command', command)))).actions[0]!.params!.command, command)
const tool = { name: 'read', parameters: { type: 'object', properties: {
  file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' },
}, required: ['file_path'] } }
assert.equal(repairAndValidateActions(parsed.actions, new Set(['read']), new Map([['read', tool]])).problems.length, 0)
assert.ok(repairAndValidateActions(parsed.actions, new Set()).problems.length)
const malformed = [recorded.slice(0, -22), recorded + invocation('pwsh', ''),
  calls(invocation('read', parameter('offset', 'NaN', false))),
  calls(invocation('read', parameter('file_path', 'a') + parameter('file_path', 'b'))),
  calls(invocation('write', parameter('content', '{"tool":"pwsh","arguments":{}}'))).slice(0, -22),
]
for (const text of malformed) {
  assert.equal(parseWebReply(text).hasActions, false)
  assert.equal(looksLikeIntendedToolReply(text), true)
}
assert.ok(repairAndValidateActions(parseWebReply('{"actions":[{"tool":"read","arguments":[]}]}').actions,
  new Set(['read']), new Map([['read', tool]])).problems.length)

const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dsml-'))
try {
  for (const autoCorrectMalformed of [false, true]) {
    const stateFile = path.join(dir, `${autoCorrectMalformed}.json`)
    let replies = [{ text: recorded, accumulatedUsage: 27_171 }]
    let turns = 0
    const channel = { ensureReady: async () => {}, resetConversationGate() {}, status: async () => ({ ready: true }),
      focusBrowser: async () => {}, focusHarness: async () => {}, dispose: async () => {},
      turn: async () => { turns++; return replies.shift()! } }
    const adapter = new DeepSeekWebAdapter(liveConfig(Config({ stateFile, autoCorrectMalformed, focus: { enabled: false } })), channel)
    const request = (id: string) => ({ sessionId: 'task', model: 'deepseek-web-auto', tools: [tool],
      messages: [{ id, role: 'user', content: [{ type: 'text', text: '分析这个项目，继续读取文件' }] }],
    } as GenerateOptions)
    const consume = async (id: string) => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(request(id))) chunks.push(chunk)
      return chunks
    }
    const chunks = await consume('u1')
    assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 4)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
    assert.ok(!chunks.some(c => c.type === 'usage'), '未分类网页总量不能冒充输出 token')
    const before = JSON.parse(await readFile(stateFile, 'utf8')).task
    replies = Array.from({ length: autoCorrectMalformed ? 2 : 1 }, () => ({ text: malformed[0]!, accumulatedUsage: 1 }))
    await assert.rejects(consume('u2'), /工具调用格式仍无法完整解析/)
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).task, before)
    assert.equal(turns, autoCorrectMalformed ? 3 : 2)
    replies = [{ text: '{"actions":[{"tool":"disallowed","arguments":{}}]}', accumulatedUsage: 1 },
      ...(autoCorrectMalformed ? [{ text: '{"actions":[{"tool":"disallowed","arguments":{}}]}', accumulatedUsage: 1 }] : [])]
    await assert.rejects(consume('u2'), /本地审查拒绝执行/)
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).task, before)
  }
  console.log('OK: DSML 多动作与参数保真、白名单校验、畸形输出拒绝、失败状态保护与用量分类正常')
} finally { await rm(dir, { recursive: true, force: true }) }
