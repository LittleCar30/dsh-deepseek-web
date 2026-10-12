/**
 * 校验网页端 token 用量解析（离线可复现）：
 * 1. 全量 upsert（accumulated_token_usage）与 BATCH 补丁都能提取累计值；
 * 2. 多次上报取最后一次（FINISHED 时的值）；
 * 3. 会话累计口径的逐轮做差逻辑。
 */
import { parseCompletionBody } from '../src/playwright-channel.ts'

const sse = (accumulatedAtWip: number, accumulatedFinal: number | null): string => [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  `data: {"v":{"response":{"message_id":2,"status":"WIP","accumulated_token_usage":${accumulatedAtWip},"fragments":[{"id":2,"type":"THINK","content":"想想"},{"id":3,"type":"RESPONSE","content":"你好"}]}}}`,
  '',
  // 显式指针补丁（设定 lastPatchPath）之后才可能出现 {"v":…} 连续增量
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，世界"}',
  'data: {"v":"!"}',
  '',
  ...accumulatedFinal === null
    ? []
    : [`data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":${accumulatedFinal}},{"p":"quasi_status","v":"FINISHED"}]}`, ''],
].join('\n')

// 第一次抓取：BATCH 前的中途状态（无 BATCH → 取 upsert 值）
const mid = parseCompletionBody(sse(67, null))
if (mid.accumulatedUsage !== 67) {
  console.error(`FAIL: 中途累计应为 67，实际 ${mid.accumulatedUsage}`)
  process.exit(1)
}

// 完整流：BATCH FINISHED 的 92 覆盖 upsert 的 67
const done = parseCompletionBody(sse(67, 92))
if (done.accumulatedUsage !== 92) {
  console.error(`FAIL: FINISHED 累计应为 92，实际 ${done.accumulatedUsage}`)
  process.exit(1)
}
if (done.text !== '你好，世界!' || done.reliable !== true) {
  console.error(`FAIL: 正文解析异常：${JSON.stringify({ text: done.text, reliable: done.reliable })}`)
  process.exit(1)
}

// 只有 BATCH、无全量 upsert 的流也要能提取
const batchOnly = parseCompletionBody('data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":117},{"p":"quasi_status","v":"FINISHED"}]}\n\n')
if (batchOnly.accumulatedUsage !== 117) {
  console.error(`FAIL: 仅 BATCH 应提取 117，实际 ${batchOnly.accumulatedUsage}`)
  process.exit(1)
}

// 逐轮做差（会话累计口径）：与 adapter.accountUsage 相同的算式
const delta = (current: number, baseline: number | undefined, initialize: boolean): number => {
  const base = typeof baseline === 'number' ? baseline : initialize ? 0 : current
  return Math.max(0, Math.round(current - base))
}
if (delta(117, 92, false) !== 25) {
  console.error('FAIL: 已有基线的增量应为 25')
  process.exit(1)
}
if (delta(67, undefined, true) !== 67) {
  console.error('FAIL: 新对话首轮回退基线应为 0')
  process.exit(1)
}
if (delta(92, undefined, false) !== 0) {
  console.error('FAIL: 重启附着首轮只作基线，不计增量')
  process.exit(1)
}

console.log('OK')
