/** 用真实抓包样本或合成 Connect-RPC 帧验证 Kimi 解析器。 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseKimiCompletion } from '../src/kimi-channel.ts'

const dir = path.join(process.env.LOCALAPPDATA ?? '', 'DshDeepSeekWeb', 'calibration')
const bins = (() => {
  try {
    return readdirSync(dir).filter(name => name.startsWith('kimi-chat-') && name.endsWith('.bin')).sort()
  } catch {
    return []
  }
})()

let parsed
if (bins.length > 0) {
  const sampleFile = path.join(dir, bins.at(-1)!)
  parsed = parseKimiCompletion(readFileSync(sampleFile))
  console.log(`[kimi-parse-check] 使用真实样本 ${sampleFile}`)
} else {
  console.log('[kimi-parse-check] 未找到真实样本，改用合成 Connect-RPC 帧自测（真实校准请运行 inspect-kimi.mjs）')
  const frame = (flags: number, payload: Buffer | string): Buffer => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
    const header = Buffer.alloc(5)
    header[0] = flags
    header.writeUInt32BE(body.length, 1)
    return Buffer.concat([header, body])
  }
  parsed = parseKimiCompletion(Buffer.concat([
    frame(0, JSON.stringify({ op: 'set', mask: 'block.text', block: { id: '1', text: { content: '审核' } } })),
    frame(0, JSON.stringify({ op: 'append', mask: 'block.text.content', block: { id: '1', text: { content: '通过' } } })),
    frame(0, JSON.stringify({ op: 'set', mask: 'block.think', block: { id: '2', think: { content: '检查' } } })),
    frame(2, Buffer.alloc(0)),
  ]))
}
console.log(JSON.stringify(parsed))
if (parsed.text !== 'OK') {
  if (bins.length === 0 && parsed.text === '审核通过') {
    console.log('OK')
    process.exit(0)
  }
  console.error('FAIL: 期望真实样本 text=OK')
  process.exit(1)
}
console.log('OK')
