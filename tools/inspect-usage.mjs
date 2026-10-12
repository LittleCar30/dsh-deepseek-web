#!/usr/bin/env node
/**
 * 校准探针：抓一次 chat.deepseek.com 对话完成接口的完整响应体，
 * 落盘到 calibration/deepseek-auto-<ts>.bin 并打印 token/用量相关字段结构。
 *
 * 用法：node tools/inspect-usage.mjs   （需常驻 Edge 已在 9333）
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const appData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const calibrationDir = path.join(appData, 'DshDeepSeekWeb', 'calibration')
fs.mkdirSync(calibrationDir, { recursive: true })

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const context = browser.contexts()[0]
if (!context) throw new Error('CDP context not found')
const page = context.pages().find(p => p.url().startsWith('https://chat.deepseek.com'))
  ?? context.pages()[0]
if (!page) throw new Error('chat.deepseek.com page not found')
console.log('page:', page.url())

// 新建对话，避免污染当前映射
try {
  const newChat = page.getByText('开启新对话', { exact: true }).first()
  if (await newChat.isVisible().catch(() => false)) await newChat.click({ timeout: 3000 })
  else {
    const alt = page.getByRole('button', { name: /新建对话|新对话|New chat/i }).first()
    if (await alt.isVisible().catch(() => false)) await alt.click({ timeout: 3000 })
  }
  await page.waitForTimeout(1200)
} catch (error) {
  console.log('new-chat click skipped:', error.message)
}

const responsePromise = page.waitForResponse(async response => {
  if (response.request().method() !== 'POST') return false
  if (!/\/chat\/completion/i.test(response.url())) return false
  return true
}, { timeout: 90_000 })

const editor = page.locator(['textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'].join(', ')).filter({ visible: true }).last()
await editor.click()
await page.keyboard.press('Control+a')
await page.keyboard.press('Backspace')
await page.keyboard.insertText('1')
await page.keyboard.press('Enter')
console.log('probe sent, waiting for completion response…')

const response = await responsePromise
await response.finished().catch(() => {})
const body = await response.body().catch(() => Buffer.from(''))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outFile = path.join(calibrationDir, `deepseek-auto-${stamp}.bin`)
fs.writeFileSync(outFile, body)
console.log('status:', response.status(), '| url:', response.url())
console.log('body bytes:', body.length, '→', outFile)

const text = body.toString('utf8')
// 扫 token/usage 相关字段
const keys = {}
for (const match of text.matchAll(/"(\w*[Tt]oken\w*|\w*[Uu]sage\w*|\w*[Pp]rompt\w*|\w*[Cc]ompletion\w*)"\s*:/g)) {
  keys[match[1]] = (keys[match[1]] ?? 0) + 1
}
console.log('token/usage-ish keys:', JSON.stringify(keys))
// 找数值示例
for (const match of text.matchAll(/.{0,40}"(?:\w*[Tt]oken\w*|\w*[Uu]sage\w*)"\s*:\s*[^,}]{1,40}/g)) {
  console.log('  sample:', match[0].replace(/\n/g, ' ').slice(0, 120))
}
process.exit(0)
