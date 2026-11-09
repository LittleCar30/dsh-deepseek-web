/** 用明确指定的实际 DSH 包运行流协议契约；不执行宿主工具。
 * npx tsx tools/host-tool-compat-check.ts <dsh/node_modules/@deepseek-ai>
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { buildToolCatalog } from '../src/protocol.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const root = process.argv[2]
assert.ok(root, '请传入实际 DSH node_modules/@deepseek-ai 路径')
const hostImport = (pkg: string) => import(pathToFileURL(path.resolve(root, pkg, 'lib/index.js')).href)
const host = await hostImport('dsh-llm')
const hostTools = await hostImport('dsh-tools')
const manifest = JSON.parse(await readFile(path.resolve(root, 'dsh-llm/package.json'), 'utf8'))
const schema = hostTools.parameterSchemaSpecToJsonSchema({ input: {
  type: 'string', required: true, description: 'Codex patch text.',
} })
const tool = { name: 'apply_patch', description: 'Apply a patch.', parameters: schema }
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-tools-'))
try {
  const config = liveConfig(Config({ stateFile: path.join(tempDir, 'state.json'), toolAllowlist: [], focus: { enabled: false } }))
  let count = 0
  let capturedPrompt = ''
  const adapter = new DeepSeekWebAdapter(config, {
    ensureReady: async () => {}, resetConversationGate() {}, status: async () => ({ ready: true }),
    focusBrowser: async () => {}, focusHarness: async () => {}, dispose: async () => {},
    turn: async request => {
      capturedPrompt = request.text
      return { text: count++ === 0
        ? JSON.stringify({ actions: [{ tool: 'apply_patch', arguments: { input: '*** Begin Patch\n*** End Patch' } }] })
        : '验证完成。' }
    },
  })
  const messages = [host.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '修改文件并报告结果。' }] })]
  const request = () => ({ provider: 'deepseek-web', model: 'deepseek-web-auto', sessionId: 'host-tools', messages, tools: [tool] }) as GenerateOptions
  const first = new host.BlockAssembler()
  for await (const chunk of adapter.stream(request())) first.push(chunk)
  assert.equal(first.finish.kind, 'tool-calls')
  const call = first.blocks()[0]
  assert.equal(call.type, 'tool-call')
  assert.equal(call.name, 'apply_patch')
  assert.deepEqual(hostTools.validateJsonSchemaValue(schema, JSON.parse(call.arguments), ''), [])
  assert.ok(capturedPrompt.includes(buildToolCatalog([tool])))
  messages.push(host.createAssistantMessage({ source: { provider: 'deepseek-web', model: 'deepseek-web-auto' }, content: first.blocks() }))
  messages.push(host.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: '补丁处理成功' }], isError: false }))
  const second = new host.BlockAssembler()
  for await (const chunk of adapter.stream(request())) second.push(chunk)
  assert.equal(second.finish.kind, 'stop')
  assert.deepEqual(second.blocks(), [{ type: 'text', text: '验证完成。' }])
  assert.ok(capturedPrompt.includes('工具 apply_patch 的执行结果'))
  assert.ok(capturedPrompt.includes('补丁处理成功'))
  console.log(`OK: 实际 DSH ${manifest.version} 工具Schema编译/校验、BlockAssembler、多轮结果回传契约（浏览器为脚本替身）`)
} finally { await rm(tempDir, { recursive: true, force: true }) }
