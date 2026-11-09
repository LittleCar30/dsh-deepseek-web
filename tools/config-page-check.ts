/** Regression checks for the draft-to-host persistence boundary. */
import assert from 'node:assert/strict'
import { CONFIG_FIELDS, draftErrors, draftOperations, editConfig, fieldValue, type ConfigDraft } from '../src/client/config-form.ts'
import { Config } from '../src/config.ts'

const accepted = { sendMode: 'model', review: { enabled: false, provider: 'kimi', maxRounds: 1 }, rateLimit: { retryDelayMs: 30000 }, toolAllowlist: ['read'], unrelated: { preserve: true } }
let draft: ConfigDraft<number> | null = null
draft = editConfig(draft, accepted, 4, 'review.enabled', true)
draft = editConfig(draft, { ...accepted, unrelated: { preserve: 'changed remotely' } }, 5, 'sendMode', 'auto')
assert.equal(draft.revision, 4, 'first-edit revision must be preserved for host conflict checks')
assert.equal(draft.base, accepted, 'edits must not silently rebase onto newer host data')
assert.deepEqual(draftOperations(draft), [
  { op: 'set', path: ['sendMode'], value: 'auto' },
  { op: 'set', path: ['review', 'enabled'], value: true },
], 'only edited leaves are sent, preserving unrelated and nested sibling fields')
assert.equal(accepted.review.enabled, false, 'draft editing must not mutate the host snapshot')

draft = editConfig(null, accepted, 4, 'rateLimit.retryDelayMs', '')
assert.match(draftErrors(draft)['rateLimit.retryDelayMs']!, /整数/)
assert.deepEqual(draftOperations(draft), [], 'empty numeric input must never persist as null or zero')
for (const invalid of ['NaN', 'Infinity', '1.2', '-1']) {
  const next = editConfig(null, accepted, 4, 'rateLimit.retryDelayMs', invalid)
  assert.equal(Object.keys(draftErrors(next)).length, 1, `invalid numeric input ${invalid} must be rejected`)
}
draft = editConfig(null, accepted, 4, 'rateLimit.retryDelayMs', '45000')
assert.deepEqual(draftOperations(draft), [{ op: 'set', path: ['rateLimit', 'retryDelayMs'], value: 45000 }])

const rawList = 'read\n\nmcp__host__*\n'
draft = editConfig(null, accepted, 4, 'toolAllowlist', rawList)
assert.equal(draft.edits.toolAllowlist, rawList, 'blank lines and trailing newline must survive while typing')
assert.deepEqual(draftOperations(draft), [{ op: 'set', path: ['toolAllowlist'], value: ['read', 'mcp__host__*'] }])
draft = editConfig(null, accepted, 4, 'toolAllowlist', [])
assert.deepEqual(draftOperations(draft), [{ op: 'set', path: ['toolAllowlist'], value: [] }], 'clear-all must persist an empty allowlist')

draft = editConfig(null, accepted, 4, 'sendMode', 'auto')
draft = editConfig(draft, accepted, 4, 'sendMode', 'model')
assert.deepEqual(draftOperations(draft), [], 'reverted changes must not create writes')
for (const url of ['', 'file:///tmp/private', 'javascript:alert(1)']) {
  assert.ok(draftErrors(editConfig(null, accepted, 4, 'url', url)).url)
}
assert.equal(fieldValue({ sendMode: 'approved' }, CONFIG_FIELDS.find(field => field.key === 'sendMode')!), 'model')
assert.equal(new Set(CONFIG_FIELDS.map(field => field.key)).size, CONFIG_FIELDS.length)
const schema = Config.toJSON()
for (const field of CONFIG_FIELDS) {
  let node = schema.refs[schema.uid]
  for (const key of field.key.split('.')) {
    assert.equal(node.type, 'object', `schema must expose object parent for ${field.key}`)
    node = schema.refs[node.dict?.[key]]
    assert.ok(node, `configuration page field ${field.key} must exist in host schema`)
  }
  assert.equal(node.meta?.volatile, true, `configuration page field ${field.key} must be writable through host volatile projection`)
}
console.log('OK: 配置草稿隔离、revision 冲突保护、仅写修改字段、数字校验、列表换行与清空白名单')
