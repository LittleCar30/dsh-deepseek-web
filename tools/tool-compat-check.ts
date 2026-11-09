/** 动态新工具参数与多工具结果关联回归；无需执行真实工具。 */
import assert from 'node:assert/strict'
import { buildToolCatalog, renderNewWebMessages } from '../src/protocol.ts'
import { repairAndValidateActions } from '../src/response.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { SessionRegistry } from '../src/session-state.ts'
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'

const tools: ToolSchema[] = [{ name: 'apply_patch', description: 'Apply a patch. Long details.', parameters: {
  type: 'object', properties: { input: { type: 'string', description: 'Codex patch text.' } }, required: ['input'],
} }, { name: 'ask_user_question', description: 'Ask questions.', parameters: {
  type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'object',
      properties: { label: { type: 'string' }, description: { type: 'string' }, title: { type: 'string' } } } },
  }, required: ['id', 'question'] } } }, required: ['questions'],
} }]
const catalog = buildToolCatalog(tools)
const questionSchema = JSON.parse(catalog.split('\n  参数: ')[2]!)
assert.deepEqual(questionSchema, tools[1]!.parameters, '嵌套与可选参数以及名为 description/title 的参数必须保留')
assert.ok(catalog.includes('"input":{"type":"string"'))

const edit: ToolSchema = { name: 'edit', description: '', parameters: { type: 'object',
  properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
  required: ['file_path', 'old_string', 'new_string'] } }
const result = repairAndValidateActions([{ tool: 'edit', params: { path: 'a', old_str: 'x', new_str: '' } }],
  new Set(['edit']), new Map([['edit', edit]]))
assert.deepEqual(result.problems, [])
assert.deepEqual(result.actions[0]!.params, { file_path: 'a', old_string: 'x', new_string: '' })

const config = liveConfig(Config({ toolAllowlist: [], focus: { enabled: false } }))
const state = new SessionRegistry().for('batch')
const messages = [
  { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续处理文件' }] },
  { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [
    { type: 'tool-call', id: 'c1', name: 'apply_patch', arguments: '{"input":"patch"}' },
    { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: '{"questions":[]}' },
  ] },
  { id: 't2', role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2',
    content: [{ type: 'text', text: '用户答案' }] },
  { id: 't1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
    content: [{ type: 'text', text: '补丁结果' }] },
]
const options = { model: 'deepseek-web-auto', messages, tools } as unknown as GenerateOptions
const first = renderNewWebMessages(options, state, config)!.prompt.text
assert.ok(first.includes('工具 ask_user_question 的执行结果（参数: {"questions":[]}）：\n用户答案'))
assert.ok(first.includes('工具 apply_patch 的执行结果（参数: {"input":"patch"}）：\n补丁结果'))
state.initialized = true
state.lastMessageId = 't2'
const next = renderNewWebMessages(options, state, config)!.prompt.text
assert.ok(!next.includes('用户答案'))
assert.ok(next.includes('工具 apply_patch 的执行结果（参数: {"input":"patch"}）：\n补丁结果'))
const changed = renderNewWebMessages({ ...options, tools: [edit] }, state, config)!.prompt
assert.equal(changed.includeProtocol, true, '工具集合变化必须立即刷新目录')
assert.ok(changed.text.includes('- edit：'))
console.log('OK: 新工具完整参数结构、edit 双向别名、多工具乱序结果与跨游标关联')
