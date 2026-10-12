/**
 * GLM SSE 解析自测。
 *
 * 有真实抓包样本（calibration/glm-chat-*.bin，由 inspect-glm.mjs 产出）时用真实样本；
 * 没有样本（例如尚未登录 chat.z.ai）时退化为合成样本自测，保证解析器始终可验证。
 *
 * 用法：npx tsx tools/glm-parse-check.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseGlmCompletion } from '../src/glm-channel.ts'

const dir = path.join(process.env.LOCALAPPDATA ?? '', 'DshDeepSeekWeb', 'calibration')
const samples = (() => {
  try {
    return readdirSync(dir).filter(name => name.startsWith('glm-chat-') && name.endsWith('.bin')).sort()
  } catch {
    return []
  }
})()

if (samples.length > 0) {
  const sampleFile = path.join(dir, samples.at(-1)!)
  const parsed = parseGlmCompletion(readFileSync(sampleFile))
  console.log(`[glm-parse-check] 使用真实样本 ${sampleFile}`)
  console.log(JSON.stringify(parsed))
  if (parsed.text !== 'OK') {
    console.error('FAIL: 期望 text=OK')
    process.exit(1)
  }
  console.log('OK')
} else {
  console.log('[glm-parse-check] 未找到真实样本，改用合成样本自测（真实校准请运行 inspect-glm.mjs）')

  // 合成样本严格照抄真实流的形状（2026-09 实测）：
  // phase=thinking 的 delta_content 是思考、phase=answer 才是正文，
  // phase=other 带 usage，随后 done 与 [DONE] 收尾。
  const synthetic = [
    ': heartbeat',
    'data: {"type":"chat:completion","data":{"delta_content":"先想一下","phase":"thinking"}}',
    '',
    'data: {"type":"chat:completion","data":{"phase":"other","usage":{"prompt_tokens":3,"completion_tokens":2}}}',
    '',
    'data: {"type":"chat:completion","data":{"delta_content":"O","phase":"answer"}}',
    '',
    'data: {"type":"chat:completion","data":{"delta_content":"K","phase":"answer"}}',
    '',
    'data: {"type":"chat:completion","data":{"phase":"done","done":true}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const parsed = parseGlmCompletion(synthetic)
  console.log(JSON.stringify(parsed))
  if (parsed.text !== 'OK' || parsed.reasoning !== '先想一下') {
    console.error(`FAIL: 合成样本解析错误 text=${JSON.stringify(parsed.text)} reasoning=${JSON.stringify(parsed.reasoning)}`)
    process.exit(1)
  }

  // 负样例：完全解析不出正文时必须抛错，并把原始样本落盘到 calibration 目录
  const sandbox = mkdtempSync(path.join(tmpdir(), 'glm-parse-check-'))
  const previousAppData = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = sandbox
  let threw = false
  try {
    // 全是无法解析的 data 行：解析器必须抛错，并异步落盘原始样本
    parseGlmCompletion('data: <<not-json>>\n')
  } catch {
    threw = true
  } finally {
    if (previousAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousAppData
  }
  // 落盘是 fire-and-forget，等一小会儿再断言文件确实写出来了
  await new Promise(resolve => setTimeout(resolve, 500))
  const dumped = readdirSync(path.join(sandbox, 'DshDeepSeekWeb', 'calibration')).filter(
    name => name.startsWith('glm-unparsed-') && name.endsWith('.bin'),
  )
  rmSync(sandbox, { recursive: true, force: true })
  if (!threw || dumped.length === 0) {
    console.error(`FAIL: 空解析保护未生效（threw=${threw} dumped=${dumped.length}）`)
    process.exit(1)
  }
  console.log('OK（合成样本 + 空解析保护）')
}
