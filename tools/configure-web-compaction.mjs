#!/usr/bin/env node
/** 将网页模型策略写入实际 agent preset；保留现有预设和其他模型策略。 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'

const args = process.argv.slice(2)
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const profile = value('--profile')
const runtime = value('--runtime-root')
const asar = value('--asar')
const preset = value('--preset') ?? 'standard'
if (!profile || (!runtime && !asar) || !/^[a-z0-9-]+$/.test(preset)) {
  throw new Error('用法：node configure-web-compaction.mjs --profile <profile目录> (--runtime-root <dsh目录> | --asar <app.asar>) [--preset standard]')
}
async function shippedPreset() {
  const relative = `node_modules/@deepseek-ai/dsh-web-app/presets/${preset}.patch.yml`
  if (runtime) return fs.readFile(path.join(runtime, relative), 'utf8')
  const handle = await fs.open(asar, 'r')
  try {
    const prefix = Buffer.alloc(16); await handle.read(prefix, 0, 16, 0)
    const length = prefix.readUInt32LE(12)
    if (length > 64 * 1024 * 1024) throw new Error('ASAR 头长度异常')
    const header = Buffer.alloc(length); await handle.read(header, 0, length, 16)
    let entry = JSON.parse(header.toString())
    for (const key of `dsh/${relative}`.split('/')) entry = entry.files?.[key]
    if (!entry || entry.unpacked || !entry.size) throw new Error('找不到内置预设，请改用 --runtime-root')
    const content = Buffer.alloc(entry.size)
    await handle.read(content, 0, content.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset))
    return content.toString()
  } finally { await handle.close() }
}
const patchFile = path.join(path.resolve(profile), 'cordis.patch.yml')
const original = await fs.readFile(patchFile, 'utf8')
const doc = parseDocument(original)
if (doc.errors.length || !Array.isArray(doc.toJS())) throw new Error('profile patch 不是有效 YAML 数组')
const id = `preset-${preset}`
const existing = doc.contents.items.filter(row => row?.get?.('id') === id)
if (existing.length > 1) throw new Error('存在重复预设覆盖，请先合并')
let row = existing[0]
if (!row) {
  const shipped = parseDocument(await shippedPreset())
  if (shipped.errors.length) throw new Error('内置预设 YAML 无法解析')
  row = shipped.contents.items.flatMap(item => item.get('insert')?.items ?? []).find(item => item.get('id') === id)?.clone()
  if (!row) throw new Error('找不到内置预设行')
  doc.contents.add(row)
}
const plugins = row.getIn(['config', 'plugins'])
if (!plugins?.items) throw new Error('已有预设覆盖缺少完整 plugins；为避免覆盖个人预设，停止更新')
let compactor
function find(nodes) {
  for (const item of nodes) {
    if (item?.get?.('id') === 'compaction-basic') compactor = item
    const config = item?.get?.('config')
    if (config?.items && item.get('group') === true) find(config.items)
  }
}
find(plugins.items)
if (!compactor) throw new Error('预设没有 compaction-basic，未作改动')
const config = compactor.get('config')?.toJSON() ?? {}
const policies = config.modelPolicies ?? []
if (!Array.isArray(policies)) throw new Error('modelPolicies 不是数组')
const models = ['deepseek-web', 'deepseek-web-auto', 'deepseek-web-chat', 'deepseek-web-reasoner', 'deepseek-web-search']
config.modelPolicies = [...policies.filter(p => !(p.provider === 'deepseek-web' && models.includes(p.model))),
  ...models.map(model => ({ ...policies.find(p => p.provider === 'deepseek-web' && p.model === model),
    provider: 'deepseek-web', model, thresholdRatio: 0.8, headroomTokens: 8192, maxTokens: 4096 }))]
compactor.set('config', doc.createNode(config))
const updated = doc.toString()
if (updated === original) { console.log('网页压缩策略已是最新。'); process.exit(0) }
const backup = `${patchFile}.${Date.now()}.bak`
await fs.copyFile(patchFile, backup)
await fs.writeFile(patchFile, updated)
console.log(`已更新 ${id} 的网页模型压缩策略：headroom=8192、summary maxTokens=4096；其他模型策略保留。\n备份：${backup}\n重启 dsh 后生效。`)
