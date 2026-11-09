/** 合成 SSE 流测试：验证 fragment upsert + JSON Pointer 补丁重建逻辑。 */
import { parseCompletionBody } from '../src/playwright-channel.ts'
import assert from 'node:assert/strict'

const lines = [
  'event: ready',
  'data: {"request_message_id":1}',
  '',
  'data: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"我们"}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"收到"}',
  'data: {"v":"需要"}',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"{"}]}',
  'data: {"p":"response/fragments/-1/content","v":"\\"actions\\":["}',
  'data: {"v":"{\\"tool\\":\\"read\\",\\"arguments\\":{\\"file_path\\":\\"a.txt\\"}}"}',
  'data: {"v":"]}"}',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
]

const parsed = parseCompletionBody(lines.join('\n'))
console.log(JSON.stringify(parsed))

const expectedText = '{"actions":[{"tool":"read","arguments":{"file_path":"a.txt"}}]}'
if (parsed.text !== expectedText) {
  console.error(`FAIL: text mismatch\nexpected: ${expectedText}\nactual:   ${parsed.text}`)
  process.exit(1)
}
console.log('OK')

const stream = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
const patched = parseCompletionBody(stream(
  { v: { response: { fragments: [{ id: 1, type: 'THINK', content: '先' }] } } },
  { p: '/response/fragments/-1/content', o: 'APPEND', v: '思考' },
  { p: 'response', o: 'BATCH', v: [
    { p: 'fragments', o: 'APPEND', v: [{ id: 2, type: 'RESPONSE', content: '旧' }] },
    { p: 'fragments/1/content', o: 'SET', v: '新' },
    { p: 'fragments/0/content', o: 'APPEND', v: '完成' },
    { p: 'accumulated_token_usage', v: 10 },
    { p: 'finish_reason', v: 'stop' },
  ] },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: '正文' },
  { v: '。' },
))
assert.equal(patched.text, '新正文。')
assert.equal(patched.reasoning, '先思考完成')
assert.equal(patched.accumulatedUsage, 10)
assert.equal(patched.finishReason, 'stop')
const replacement = parseCompletionBody(stream(
  { v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: '废弃' }] } } },
  { p: 'response/fragments', o: 'SET', v: [{ id: 2, type: 'THINK', content: '修订' }] },
  { p: 'response/fragments/0/type', o: 'SET', v: 'RESPONSE' },
))
assert.equal(replacement.text, '修订')
assert.equal(replacement.reasoning, undefined)
// 2026-11-09 登录网页实测：elapsed_secs 的 SET 后，fragments 快照省略 o 继承 SET。
const observedTransition = parseCompletionBody(stream(
  { v: { response: { fragments: [{ id: 2, type: 'THINK', content: '思考' }] } } },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: '结束' },
  { p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 0.7 },
  { p: 'response/fragments', v: [
    { id: 2, type: 'THINK', content: '思考结束' }, { id: 3, type: 'RESPONSE', content: '正式' },
  ] },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: '回答' },
))
assert.equal(observedTransition.text, '正式回答')
assert.equal(observedTransition.reasoning, '思考结束')
console.log('OK: THINK 尾片段、显式索引、SET 替换、嵌套 BATCH 与连续增量')
