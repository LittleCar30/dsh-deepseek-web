/** 验证 Kimi 解析器能处理 gzip 压缩帧（Connect flags bit0=1）。 */
import { gzipSync } from 'node:zlib'
import { parseKimiCompletion } from '../src/kimi-channel.ts'

function frame(flags: number, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

const events = [
  frame(1, gzipSync(Buffer.from(JSON.stringify({ op: 'set', mask: 'block.text', block: { id: '4', text: { content: '审核' } } })))),
  frame(1, gzipSync(Buffer.from(JSON.stringify({ op: 'append', mask: 'block.text.content', block: { id: '4', text: { content: '通过' } } })))),
  frame(0, JSON.stringify({ op: 'set', mask: 'message.status', message: { status: 'MESSAGE_STATUS_COMPLETED' } })),
  frame(2, Buffer.alloc(0)),
]

const parsed = parseKimiCompletion(Buffer.concat(events))
console.log(JSON.stringify(parsed))
if (parsed.text !== '审核通过') {
  console.error('FAIL: gzip 帧解析不正确')
  process.exit(1)
}
console.log('OK')
