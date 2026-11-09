/** Verify the shipped DSH loader/control plugin. No live host tools or sessions are used. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

assert.ok(process.argv[2], 'Pass the extracted actual dsh directory')
const root = path.resolve(process.argv[2])
const host = p => import(pathToFileURL(path.join(root, 'node_modules/@deepseek-ai', p)).href)
const { Context } = await host('cordis/lib/index.js')
const { Loader } = await host('cordis-plugin-loader/lib/index.js')
const ctx = new Context()
const registered = new Map()
const calls = []
ctx.provide('tools', { register(tool) { registered.set(tool.name, tool) } })
ctx.provide('subagents', {
  async listChildren(id) { calls.push(id); return [] },
  async listDescendants(id) { calls.push(id); return [] },
})
ctx.provide('agents', { get() {} })
const loader = new Loader(ctx, {
  baseUrl: pathToFileURL(path.join(root, 'node_modules/@deepseek-ai/dsh-tool-subagent-control/package.json')).href,
})
try {
  await ctx.fiber.await()
  const main = { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' }
  const old = { id: 'tool-subagent-list-agents', name: main.name + '/list-agents' }
  await loader.root.update([main, old])
  await loader.await()
  assert.equal(loader.store[old.id].fiber, undefined, 'obsolete export cannot start')
  assert.ok(ctx.logger.buffer.some(log => log.args.some(arg => arg?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')))
  await loader.store[main.id].fiber.await()
  assert.deepEqual([...registered.keys()], ['list_agents', 'send_message', 'interrupt_agent'])
  const tool = registered.get('list_agents')
  assert.ok(tool)
  // The actual tool handler uses only the service seams supplied above.
  const result = await tool.execute({ scope: 'children' }, { agent: { id: 'compat-parent' }, signal: new AbortController().signal })
  assert.deepEqual(calls, ['compat-parent'])
  assert.ok(result)
  await loader.root.update([main])
  await loader.await()
  for (const entry of loader.entries()) {
    assert.ok(entry.fiber, entry.options.id)
    await entry.fiber.await()
  }
  console.log('OK: actual DSH loader reproduces obsolete list-agents failure; main entry registers all three tools and list_agents executes; corrected tree has no failed imports (service fixtures, no desktop session creation)')
} finally { await ctx.fiber.dispose() }
