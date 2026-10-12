/**
 * Kimi 网页版一次性登录引导（独立 profile，工作区外）。
 *
 * 用法：node tools/open-login-kimi.mjs
 */

import { chromium } from 'playwright-core'
import path from 'node:path'

const appDataRoot = process.env.LOCALAPPDATA
  ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const profileDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'kimi-profile')
const url = 'https://www.kimi.com/'

console.log('Kimi 登录引导')
console.log('=============')
console.log(`Profile: ${profileDir}`)

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
})

const page = context.pages()[0] ?? (await context.newPage())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.bringToFront()

const editorSelectors = [
  'textarea',
  'div[contenteditable="true"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
]
const loginMarkers = ['sign_in', 'sign-in', 'login', 'auth', 'passport']
const deadline = Date.now() + 10 * 60_000
let lastLogAt = Date.now()
let detected = false

while (Date.now() < deadline) {
  const editorVisible = await page.locator(editorSelectors.join(', '))
    .filter({ visible: true }).first().isVisible().catch(() => false)
  const current = page.url()
  const looksOut = loginMarkers.some(marker => current.includes(marker))
  if (editorVisible && !looksOut) {
    detected = true
    console.log('检测到已登录对话页，正在保存登录态...')
    await page.waitForTimeout(3_000)
    break
  }
  if (Date.now() - lastLogAt > 15_000) {
    lastLogAt = Date.now()
    console.log('仍在等待登录...')
  }
  await page.waitForTimeout(2_000)
}

await context.close()
console.log(detected ? '已保存登录态，profile 可复用。' : '等待登录超时（10 分钟）。')

