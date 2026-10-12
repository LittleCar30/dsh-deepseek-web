/**
 * Kimi 网页版协议校准：填入探测消息，由人工点击发送，抓取完整响应样本。
 *
 * 用法：node tools/inspect-kimi.mjs
 * 产物：%LOCALAPPDATA%\DshDeepSeekWeb\calibration\kimi-*.txt
 */

import { chromium } from 'playwright-core'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const appDataRoot = process.env.LOCALAPPDATA
  ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const profileDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'kimi-profile')
const outDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'calibration')
const url = 'https://www.kimi.com/'

await mkdir(outDir, { recursive: true })

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
})

const page = context.pages()[0] ?? (await context.newPage())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.bringToFront()
await page.waitForTimeout(2_000)

const editorSelectors = [
  'textarea',
  'div[contenteditable="true"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
]
const editor = page.locator(editorSelectors.join(', ')).filter({ visible: true }).last()
if (!(await editor.isVisible().catch(() => false))) {
  console.log('未找到输入框：请先运行 open-login-kimi.mjs 完成登录。')
  await context.close()
  process.exit(1)
}

const captured = []
page.on('response', async response => {
  if (response.request().method() !== 'POST') return
  const responseUrl = response.url()
  const buffer = await response.body().catch(() => Buffer.alloc(0))
  const text = buffer.toString()
  if (!buffer.length) return
  captured.push({
    url: responseUrl,
    status: response.status(),
    contentType: response.headers()['content-type'] ?? '',
    requestBody: response.request().postData()?.slice(0, 4_000) ?? '',
    bodyLength: buffer.length,
    base64: buffer.subarray(0, 200_000).toString('base64'),
  })
  const safeName = responseUrl.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
  await writeFile(path.join(outDir, `kimi-${Date.now()}-${safeName}.txt`), text).catch(() => {})
  if (/ChatService\/Chat/i.test(responseUrl)) {
    await writeFile(path.join(outDir, `kimi-chat-${Date.now()}.bin`), buffer).catch(() => {})
  }
})

await editor.click()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
await page.keyboard.press('Backspace')
await page.keyboard.insertText('[校准探测] 请只回复：OK')
await page.bringToFront()
console.log('已填入探测消息，请在 Kimi 页面人工点击“发送”，等待回复结束...')

await Promise.race([
  page.waitForTimeout(300_000).then(() => false),
  page.waitForResponse(
    response => response.request().method() === 'POST' && /completion|chat|connect/i.test(response.url()),
    { timeout: 300_000 },
  ).then(async response => {
    await response.finished().catch(() => {})
    await page.waitForTimeout(5_000)
    return true
  }),
])

await writeFile(path.join(outDir, 'kimi-responses.json'), JSON.stringify(captured, null, 2)).catch(() => {})
console.log(`观测到 ${captured.length} 个响应，样本已写入 ${outDir}`)
await context.close()
