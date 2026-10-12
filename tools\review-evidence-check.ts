/** 验证审核证据：优先读磁盘完整文件、截断处带明确标注。 */
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReviewEvidence } from '../src/protocol.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(projectRoot, '.runtime')
await mkdir(dir, { recursive: true })
const file = path.join(dir, 'evidence-check.txt')
const content = `BEGIN\n${'x'.repeat(3_000)}\nEND-OF-FILE`
await writeFile(file, content, 'utf8')

const messages = [{
  id: 'm1',
  role: 'assistant',
  content: [{
    type: 'tool-call',
    id: 'c1',
    name: 'write',
    arguments: JSON.stringify({ file_path: file, content: '旧内容' }),
  }],
  source: { kind: 'model', provider: 'deepseek-web', model: 'deepseek-web' },
}]

const state = { goalText: '测试任务', roundsSinceProtocol: 0, lastParseOk: true, initialized: true, roundsInConversation: 1, charsInConversation: 0, reviewRoundsUsed: 0 }

const full = await buildReviewEvidence({ messages } as never, state, '交付说明', 60_000)
if (!full.artifact.includes('END-OF-FILE') || full.artifact.includes('旧内容')) {
  console.error('FAIL: 未使用磁盘上的完整文件内容')
  process.exit(1)
}

const clipped = await buildReviewEvidence({ messages } as never, state, '交付说明', 1_200)
if (!clipped.artifact.includes('审核证据被截断')) {
  console.error('FAIL: 截断未标注')
  process.exit(1)
}

await unlink(file).catch(() => {})
console.log('OK')
