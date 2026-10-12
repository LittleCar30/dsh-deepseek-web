/**
 * 一次性登录引导：启动独立 Edge 窗口并打开 chat.deepseek.com。
 *
 * 用法：node tools/open-login.mjs
 *
 * 登录成功后按回车退出；登录态保存在 .runtime/edge-profile，
 * 之后 dsh 网页通道直接复用该 profile，无需再次登录。
 */

import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDataRoot = process.env.LOCALAPPDATA
  ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const profileDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'edge-profile')

console.log('DeepSeek Web 登录引导')
console.log('======================')
console.log(`Profile: ${profileDir}`)

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
})

const page = context.pages()[0] ?? (await context.newPage())
await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.bringToFront()

console.log('\n请在弹出的 Edge 窗口中完成登录。脚本会自动检测登录状态并退出。')

const editorSelectors = [
  'textarea',
  'div[contenteditable="true"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
]

const loginMarkers = ['sign_in', 'sign-in', 'login', 'auth']
const deadline = Date.now() + 10 * 60_000
let announced = false
let lastLogAt = Date.now()

async function looksLoggedIn() {
  const url = page.url()
  const editorVisible = await page.locator(editorSelectors.join(', '))
    .filter({ visible: true }).first().isVisible().catch(() => false)
  if (editorVisible) return true
  const newChatButton = await page.getByRole('button', { name: /新建对话|新对话|New chat|New Chat/i })
    .first().isVisible().catch(() => false)
  if (newChatButton) return true
  if (loginMarkers.some(m => url.includes(m))) return false
  return false
}

while (Date.now() < deadline) {
  if (await looksLoggedIn()) {
    if (!announced) {
      announced = true
      console.log('检测到已登录聊天页，正在保存登录态...')
    }
    await page.waitForTimeout(3_000)
    break
  }
  if (!announced && Date.now() - lastLogAt > 15_000) {
    lastLogAt = Date.now()
    console.log('仍在等待登录...')
  }
  await page.waitForTimeout(2_000)
}

await context.close()
console.log(announced ? '已保存登录态，profile 可复用。' : '等待登录超时（10 分钟）。请检查 Edge 窗口后重试。')
