/**
 * 校验上下文长度上限的自动轮换支持（离线可复现）：
 * 1. 网页流里的 hint（finish_reason=context_length_exceeded）能被识别；
 * 2. buildHandoffBrief 能从会话日志消息里提取任务简报（原始任务/已完成/进度/待办）。
 */
import { parseCompletionBody } from '../src/playwright-channel.ts'
import { buildHandoffBrief } from '../src/protocol.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

// ---- 1) hint 识别（标准 SSE 分行形态）----
const sampleSplit = [
  'event: ready',
  'data: {"request_message_id":73,"response_message_id":74,"model_type":"default"}',
  '',
  'event: hint',
  'data: {"type":"error","content":"达到对话长度上限，请开启新对话","clear_response":true,"finish_reason":"context_length_exceeded"}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
  '',
].join('\n')
const parsedSplit = parseCompletionBody(sampleSplit)
if (parsedSplit.contextLengthExceeded !== true) {
  console.error('FAIL: 分行形态的 hint 未识别')
  process.exit(1)
}

// ---- 2) hint 识别（event 与 data 同行的形态）----
const sampleInline = [
  'event: ready',
  'data: {"request_message_id":73,"response_message_id":74,"model_type":"default"}',
  '',
  'event: hint data: {"type":"error","content":"达到对话长度上限，请开启新对话","clear_response":true,"finish_reason":"context_length_exceeded"}',
  '',
  'event: close data: {"click_behavior":"none","auto_resume":false}',
  '',
].join('\n')
const parsedInline = parseCompletionBody(sampleInline)
if (parsedInline.contextLengthExceeded !== true) {
  console.error('FAIL: 同行形态的 hint 未识别')
  process.exit(1)
}

// ---- 3) 正常流不受影响 ----
const normal = parseCompletionBody([
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"message_id":2,"status":"WIP","accumulated_token_usage":5,"fragments":[{"id":1,"type":"RESPONSE","content":"你好"}]}}}',
  '',
].join('\n'))
if (normal.contextLengthExceeded === true || normal.text !== '你好') {
  console.error('FAIL: 正常流被误判或解析错误')
  process.exit(1)
}

// ---- 4) 任务简报生成 ----
const userBlock = (text: string): ContentBlock => ({ type: 'text', text })
const messages = [
  {
    id: 'm1', role: 'user' as const, source: { kind: 'user' as const },
    content: [userBlock('给项目写一个完整的 README，包含安装与使用说明')],
  },
  {
    id: 'm2', role: 'assistant' as const, source: { kind: 'assistant' as const },
    content: [
      { type: 'reasoning', text: '先写 README' } as ContentBlock,
      {
        type: 'tool-call', id: 'c1', name: 'todo_write',
        arguments: JSON.stringify({ todos: [
          { content: '调研项目结构', status: 'completed' },
          { content: '撰写 README 初稿', status: 'in_progress' },
          { content: '补充使用示例', status: 'pending' },
        ] }),
      },
    ],
  },
  {
    id: 'm3', role: 'user' as const, source: { kind: 'tool' as const },
    content: [userBlock('任务清单已更新（3 项）')],
  },
  {
    id: 'm4', role: 'assistant' as const, source: { kind: 'assistant' as const },
    content: [
      {
        type: 'tool-call', id: 'c2', name: 'write',
        arguments: JSON.stringify({ file_path: 'D:/demo/README.md', content: '# Demo' }),
      },
    ],
  },
  {
    id: 'm5', role: 'user' as const, source: { kind: 'tool' as const },
    content: [userBlock('已写入 D:/demo/README.md（214 字节）')],
  },
] as unknown as Parameters<typeof buildHandoffBrief>[0]['messages']

const brief = buildHandoffBrief(
  { messages } as unknown as Parameters<typeof buildHandoffBrief>[0],
  { goalText: '给项目写一个完整的 README，包含安装与使用说明' } as Parameters<typeof buildHandoffBrief>[1],
)

const mustContain = [
  '[任务简报]',
  '原始任务：给项目写一个完整的 README',
  '[已完成]',
  'D:/demo/README.md',
  '已完成：调研项目结构',
  '[当前进度]',
  '正在进行：撰写 README 初稿',
  '最近工具结果：write',
  '[下一步]',
  '待办：补充使用示例',
  '[上下文说明]',
  '不要反问「请提供任务」',
]
for (const marker of mustContain) {
  if (!brief.includes(marker)) {
    console.error(`FAIL: 简报缺少「${marker}」\n---\n${brief}`)
    process.exit(1)
  }
}
console.log('OK')
