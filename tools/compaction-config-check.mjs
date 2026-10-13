/** 验证配置迁移保留个人预设/其他模型策略、重复执行无改动，失败不落盘。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-compaction-config-'))
try {
  const patch = path.join(dir, 'cordis.patch.yml')
  const runtime = path.join(dir, 'runtime')
  const presets = path.join(runtime, 'node_modules/@deepseek-ai/dsh-web-app/presets')
  await mkdir(presets, { recursive: true })
  const config = `- id: unrelated\n  config: { keep: true }\n- id: preset-standard\n  config:\n    id: standard\n    plugins:\n      - id: custom\n        name: custom-plugin\n      - id: compaction\n        name: cordis:group\n        group: true\n        config:\n          - id: compaction-basic\n            name: '@deepseek-ai/dsh-compaction-basic'\n            config:\n              auto: false\n              modelPolicies:\n                - { provider: other, model: other, headroomTokens: 30000 }\n                - { provider: deepseek-web, model: deepseek-web-auto, retainTokens: 5000 }\n`
  await writeFile(patch, config)
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./configure-web-compaction.mjs', import.meta.url)),
    '--profile', dir, '--runtime-root', runtime], { encoding: 'utf8' })
  assert.equal(run().status, 0)
  const text = await readFile(patch, 'utf8')
  const rows = parse(text)
  assert.equal(rows[0].config.keep, true)
  const plugins = rows[1].config.plugins
  assert.equal(plugins[0].name, 'custom-plugin')
  const compactor = plugins[1].config[0].config
  assert.equal(compactor.auto, false)
  assert.equal(compactor.modelPolicies[0].headroomTokens, 30000)
  assert.equal(compactor.modelPolicies.find(p => p.model === 'deepseek-web-auto').retainTokens, 5000)
  assert.equal(compactor.modelPolicies.find(p => p.model === 'deepseek-web-auto').maxTokens, 4096)
  assert.equal(run().status, 0)
  assert.equal(await readFile(patch, 'utf8'), text)
  const invalid = '- id: preset-standard\n  config: { id: standard }\n'
  await writeFile(patch, invalid)
  assert.notEqual(run().status, 0)
  assert.equal(await readFile(patch, 'utf8'), invalid)
  await writeFile(path.join(presets, 'standard.patch.yml'), '- insert:\n' + config.split('\n').slice(2).map(line => '    ' + line).join('\n'))
  await writeFile(patch, '- id: unrelated\n  config: { keep: true }\n')
  assert.equal(run().status, 0)
  assert.equal(parse(await readFile(patch, 'utf8'))[1].config.plugins[0].name, 'custom-plugin')
  console.log('OK: 压缩配置保留个人预设/其他模型、可重复执行、失败不写入与内置预设迁移正常')
} finally { await rm(dir, { recursive: true, force: true }) }
