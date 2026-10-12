/** 校验参数别名修复：path/text 应被归一为 file_path/content。 */
import { repairAndValidateActions } from '../src/response.ts'

const writeSchema = {
  name: 'write',
  description: 'write a file',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
  },
}

const tools = new Map([['write', writeSchema]])
const allowed = new Set(['write'])

const repaired = repairAndValidateActions(
  [{ tool: 'write', params: { path: 'a.html', text: '<html></html>' } }],
  allowed,
  tools,
)
console.log(JSON.stringify(repaired))
if (repaired.problems.length > 0) {
  console.error('FAIL: 别名修复后仍报问题')
  process.exit(1)
}
const action = repaired.actions[0]!
if (action.params?.file_path !== 'a.html' || action.params?.content !== '<html></html>') {
  console.error('FAIL: 参数未归一')
  process.exit(1)
}

const missing = repairAndValidateActions([{ tool: 'write', params: {} }], allowed, tools)
if (missing.problems.length === 0) {
  console.error('FAIL: 空参数应被拒绝')
  process.exit(1)
}
console.log('OK')
