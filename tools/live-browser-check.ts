/** 已登录的专用浏览器端到端验证。仅使用新测试标签，不读取其它会话。
 * npx tsx tools/live-browser-check.ts <实际DSH/node_modules/@deepseek-ai> [CDP端口] [--self-review]
 * 会真实发送消息、保存测试 SSE（不保存请求头/登录数据），并保留测试报告。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { DeepSeekWebAdapter } from '../src/adapter.ts'
import { PlaywrightBrowserChannel, parseCompletionBody } from '../src/playwright-channel.ts'
import { Config } from '../src/config.ts'
import { liveConfig } from '../src/live-config.ts'
import { DeepSeekSelfReviewer } from '../src/reviewer.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const hostRoot = process.argv[2]
assert.ok(hostRoot, '请传入实际 DSH node_modules/@deepseek-ai 路径')
const port = Number(process.argv.slice(3).find(arg => !arg.startsWith('--')) ?? 9333)
const selfReview = process.argv.includes('--self-review')
const host = await import(pathToFileURL(path.resolve(hostRoot, 'dsh-llm/lib/index.js')).href)
const hostTools = await import(pathToFileURL(path.resolve(hostRoot, 'dsh-tools/lib/index.js')).href)
const runId = `live-${new Date().toISOString().replace(/[:.]/g, '-')}`
const outputDir = path.resolve('.runtime/compat-20261109', runId)
await mkdir(outputDir, { recursive: true })
const fixture = path.join(outputDir, 'fixture.txt')
const marker = `DSH_WEB_E2E_${randomUUID()}`
await writeFile(fixture, `本次兼容性验证标记：${marker}\n`, 'utf8')
const config = liveConfig(Config({ browser: 'attach', debugPort: port, autoStartKeeper: false,
  stateFile: path.join(outputDir, 'state.json'), focus: { enabled: false },
  review: { enabled: selfReview, provider: 'deepseek-web', maxRounds: 1 },
  streamIdleTimeoutMs: 180_000, rateLimit: { enabled: false }, toolAllowlist: [],
  delegatedTools: [], excludeToolNames: [], autoCorrectMalformed: true,
}))
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const context = browser.contexts()[0]!
const page = await context.newPage()
const captures: Promise<void>[] = []
const captureReports: unknown[] = []
let captureIndex = 0
page.on('response', response => {
  if (response.request().method() !== 'POST' || !/\/chat\/completion\b/i.test(response.url())) return
  const index = ++captureIndex
  captures.push((async () => {
    const body = await response.text()
    await writeFile(path.join(outputDir, `completion-${index}.sse`), body)
    const parsed = parseCompletionBody(body)
    captureReports.push({ index, status: response.status(), bodyBytes: Buffer.byteLength(body),
      reliable: parsed.reliable, textChars: parsed.text.length, reasoningChars: parsed.reasoning?.length ?? 0,
      finishReason: parsed.finishReason, accumulatedUsage: parsed.accumulatedUsage })
  })())
})
const channel = new PlaywrightBrowserChannel({ config })
// 将真实通道绑定到刚创建的独立测试标签。其它标签不参与测试、也不被读取。
Object.assign(channel, { browser, context, page })
const adapter = new DeepSeekWebAdapter(config, channel, selfReview ? new DeepSeekSelfReviewer(channel) : undefined)
const tool = { name: 'read', description: 'Read the UTF-8 test fixture file and return its full text.',
  parameters: hostTools.parameterSchemaSpecToJsonSchema({ file_path: { type: 'string', required: true,
    description: 'Absolute path to the test fixture.' } }) }
const messages = [host.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
  text: `这是插件兼容性测试。请先调用 read 工具读取这个测试文件：${fixture}。必须等工具真实返回后，最终仅输出文件中的 DSH_WEB_E2E_ 开头的完整标记。不要猜测文件内容，不要解释。` }] })]
const request = () => ({ provider: 'deepseek-web', model: 'deepseek-web-auto', sessionId: runId,
  messages, tools: [tool], signal: AbortSignal.timeout(240_000) }) as GenerateOptions
const rounds: unknown[] = []
try {
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const consume = async () => {
    const assembler = new host.BlockAssembler()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request())) { assembler.push(chunk); chunks.push(chunk) }
    rounds.push({ finish: assembler.finish, blocks: assembler.blocks(), chunks })
    return assembler
  }
  const first = await consume()
  assert.equal(first.finish.kind, 'tool-calls', '第一轮必须来自真实网页的工具调用')
  const blocks = first.blocks()
  assert.equal(blocks.length, 1)
  const call = blocks[0]
  assert.equal(call.type, 'tool-call')
  assert.equal(call.name, 'read')
  const args = JSON.parse(call.arguments)
  assert.deepEqual(hostTools.validateJsonSchemaValue(tool.parameters, args, ''), [])
  assert.equal(path.resolve(args.file_path), fixture, '工具只允许读取本次临时fixture')
  const toolText = await readFile(fixture, 'utf8')
  messages.push(host.createAssistantMessage({ source: { provider: 'deepseek-web', model: 'deepseek-web-auto' }, content: blocks }))
  messages.push(host.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: toolText }], isError: false }))
  const second = await consume()
  assert.equal(second.finish.kind, 'stop')
  const text = second.blocks().filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n')
  assert.ok(text.includes(marker), '最终正文必须包含只存在于真实工具结果中的随机标记')
  if (selfReview) {
    assert.ok(text.includes('✅ DeepSeek 审核：通过'), '实际自审必须明确通过，跳过或失败不能算成功')
    const state = JSON.parse(await readFile(path.join(outputDir, 'state.json'), 'utf8'))[runId]
    assert.equal(state.reviewRoundsUsed, 1)
  }
  await Promise.all(captures)
  assert.ok(captureReports.length >= (selfReview ? 3 : 2), '必须捕获工具轮/最终正文及启用时的自审网络响应')
  const result = { ok: true, hostVersion: JSON.parse(await readFile(path.resolve(hostRoot, 'dsh-llm/package.json'), 'utf8')).version,
    reviewMode: selfReview ? 'deepseek-web' : 'disabled', marker, testPageUrl: page.url(), captures: captureReports, rounds }
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: true, hostVersion: result.hostVersion, reviewMode: result.reviewMode, marker, captures: captureReports, outputDir }))
} catch (error) {
  await Promise.allSettled(captures)
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ ok: false, reviewMode: selfReview ? 'deepseek-web' : 'disabled',
    error: String(error), captures: captureReports, rounds }, null, 2))
  console.error(`测试报告：${outputDir}`)
  throw error
} finally {
  await page.close().catch(() => {})
  await channel.dispose().catch(() => {})
  // connectOverCDP 的 close 只释放本脚本的连接，不终止外部浏览器。
  await browser.close().catch(() => {})
}
