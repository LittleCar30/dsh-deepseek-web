/** 合成 SSE 流测试：验证 fragment upsert + JSON Pointer 补丁重建逻辑。 */
import { parseCompletionBody } from '../src/playwright-channel.ts'

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
