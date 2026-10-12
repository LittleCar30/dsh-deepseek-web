/**
 * 解析 Kimi Connect-RPC 二进制样本，打印事件序列（协议校准用）。
 *
 * 用法：node tools/dump-kimi-sample.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'

const dir = path.join(process.env.LOCALAPPDATA, 'DshDeepSeekWeb', 'calibration')
const bins = readdirSync(dir).filter(name => name.startsWith('kimi-chat-') && name.endsWith('.bin')).sort()
const file = path.join(dir, bins.at(-1))
const buffer = readFileSync(file)

console.log('file:', bins.at(-1), 'bytes:', buffer.length)

let offset = 0
let index = 0
while (offset + 5 <= buffer.length) {
  const flags = buffer[offset]
  const length = buffer.readUInt32BE(offset + 1)
  if (offset + 5 + length > buffer.length) {
    console.log('torn frame at', offset, 'declared length', length)
    break
  }
  let framePayload = buffer.subarray(offset + 5, offset + 5 + length)
  offset += 5 + length
  let compressed = false
  if ((flags & 1) !== 0) {
    compressed = true
    try {
      framePayload = gunzipSync(framePayload)
    } catch {
      // 保持原样
    }
  }
  const payload = framePayload.toString('utf8')
  let json
  try {
    json = JSON.parse(payload)
  } catch {
    console.log(String(index).padStart(2), 'non-json:', payload.slice(0, 120))
    index++
    continue
  }
  const parts = []
  if (json.op) parts.push(`op=${json.op}`)
  if (json.mask) parts.push(`mask=${json.mask}`)
  if (json.eventOffset !== undefined) parts.push(`off=${json.eventOffset}`)
  if (json.heartbeat) parts.push('heartbeat')
  if (json.chat) parts.push(`chat=${JSON.stringify({ id: json.chat.id, name: json.chat.name, lastRequest: json.chat.lastRequest ? json.chat.lastRequest.options : undefined }).slice(0, 160)}`)
  if (json.message) {
    const blocks = (json.message.blocks ?? []).map(block => {
      if (block.text?.content !== undefined) return `text:${JSON.stringify(block.text.content)}`
      if (block.multiStage) {
        return `multiStage:${(block.multiStage.stages ?? []).map(stage => `${stage.name}:${stage.status}`).join('|')}`
      }
      if (block.reasoning?.content !== undefined) return `reasoning:${JSON.stringify(block.reasoning.content)}`
      return `keys:${Object.keys(block).join('+')}`
    })
    parts.push(`message=${json.message.role}/${json.message.status}${blocks.length ? ` blocks=${blocks.join(' ; ').slice(0, 400)}` : ''}`)
  }
  if (json.block) {
    const stageInfo = json.block.multiStage
      ? ` multiStage=${(json.block.multiStage.stages ?? []).map(stage => `${stage.name}:${stage.status}`).join('|')}`
      : ''
    const text = json.block.text?.content !== undefined ? ` text=${JSON.stringify(json.block.text.content)}` : ''
    const reasoning = json.block.reasoning?.content !== undefined ? ` reasoning=${JSON.stringify(json.block.reasoning.content)}` : ''
    parts.push(`block=${JSON.stringify(Object.keys(json.block))}${stageInfo}${text}${reasoning}`)
  }
  console.log(String(index).padStart(2), 'flags=' + flags + (compressed ? '(gzip)' : ''), parts.join(' ').slice(0, 700))
  index++
}
