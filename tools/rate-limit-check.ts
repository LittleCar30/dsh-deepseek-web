/**
 * 校验频控识别与实时增量的纯逻辑（离线可复现，不需要浏览器）：
 * 1. looksLikeRateLimitText 覆盖中英文频控文案，且不误伤普通回复；
 * 2. 累计重建 + 后缀差分（playwright-channel 的进度轮询逻辑）在
 *   追加流上产生正确的增量，且在回缩时只对齐基线不发负增量。
 */
import { looksLikeRateLimitText } from '../src/browser-shared.ts'
import { parseCompletionBody } from '../src/playwright-channel.ts'

const rateLimitSamples = [
  '消息发送过于频繁，请稍后重试',
  '操作过于频繁，请稍后再试',
  '发送太快啦，休息一下吧',
  'Too many requests, please try again later',
  'You are doing that too frequently',
  'rate limited by server',
]
for (const sample of rateLimitSamples) {
  if (!looksLikeRateLimitText(sample)) {
    console.error(`FAIL: 应识别为频控：${sample}`)
    process.exit(1)
  }
}

const normalSamples = [
  '已完成任务：文件已写入 a.html',
  '好的，我会注意发送节奏',
  '{"actions":[{"tool":"read","arguments":{"file_path":"a.txt"}}]}',
]
for (const sample of normalSamples) {
  if (looksLikeRateLimitText(sample)) {
    console.error(`FAIL: 不应误判为频控：${sample}`)
    process.exit(1)
  }
}

// 实时增量差分：模拟两轮轮询，SSE 体逐步追加。
// 样本按真实协议构造：fragments 整段 upsert（THINK+RESPONSE），随后 APPEND 补丁落到最后一个片段。
const sseHead = [
  'data: {"v":{"response":{"fragments":[{"id":1,"type":"THINK","content":"先想想"}]}}}',
  'data: {"v":{"response":{"fragments":[{"id":1,"type":"THINK","content":"先想想"},{"id":2,"type":"RESPONSE","content":"你好"}]}}}',
].join('\n')
const first = parseCompletionBody(`${sseHead}\n\n`)
let emittedText = ''
let emittedReasoning = ''
const diff = (text: string, reasoning: string): { text: string; reasoning: string } => {
  if (text.length < emittedText.length) emittedText = text
  if (reasoning.length < emittedReasoning.length) emittedReasoning = reasoning
  const textDelta = text.length > emittedText.length ? text.slice(emittedText.length) : ''
  const reasoningDelta = reasoning.length > emittedReasoning.length ? reasoning.slice(emittedReasoning.length) : ''
  emittedText = text
  emittedReasoning = reasoning
  return { text: textDelta, reasoning: reasoningDelta }
}

const firstDelta = diff(first.text, first.reasoning ?? '')
if (firstDelta.reasoning !== '先想想' || firstDelta.text !== '你好') {
  console.error(`FAIL: 第一轮增量不符：${JSON.stringify(firstDelta)}`)
  process.exit(1)
}

const second = parseCompletionBody(`${sseHead}\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"，世界"}\n\n`)
const secondDelta = diff(second.text, second.reasoning ?? '')
if (secondDelta.text !== '，世界' || secondDelta.reasoning !== '') {
  console.error(`FAIL: 第二轮增量不符：${JSON.stringify(secondDelta)}`)
  process.exit(1)
}

// 回缩保护：更短的累计值只对齐基线，不产生负增量
const shrunk = diff('你好', '')
if (shrunk.text !== '' || shrunk.reasoning !== '') {
  console.error(`FAIL: 回缩时不应发增量：${JSON.stringify(shrunk)}`)
  process.exit(1)
}

console.log('OK')
