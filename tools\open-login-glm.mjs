/**
 * GLM（chat.z.ai）网页版一次性登录引导（独立 profile，工作区外）。
 *
 * 用法：node tools/open-login-glm.mjs
 *
 * 注意：chat.z.ai 的登录墙不是“输入框不可见”，而是**游客态输入框照样可见、
 * 发送按钮被禁用**。因此这里不把“看得见输入框”当成已登录，必须同时满足
 * 「无登录入口 + 发送按钮可用」，避免游客态被误判成登录成功。
 */

import { chromium } from 'playwright-core'
import path from 'node:path'

const appDataRoot = process.env.LOCALAPPDATA
  ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const profileDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'glm-profile')
const url = 'https://chat.z.ai/'

console.log('GLM 登录引导')
console.log('============')
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
const sendSelectors = [
  'button[class*="sendMessage" i]',
  'button[aria-label*="发送"]',
  'button[aria-label*="send" i]',
  'button[title*="发送"]',
  'button[title*="send" i]',
].join(', ')
const deadline = Date.now() + 10 * 60_000
let lastLogAt = Date.now()
let detected = false

/** 采集登录判定所需的四要素；只有全部成立才算已登录。 */
async function loginState() {
  const editorVisible = await page.locator(editorSelectors.join(', '))
    .filter({ visible: true }).first().isVisible().catch(() => false)
  const current = page.url()
  const looksOut = loginMarkers.some(marker => current.includes(marker))
  const signInVisible = await page
    .getByText(/^\s*(登录|登入|立即登录|Sign in|Sign in \/ Sign up|Log in|Login)\s*$/i)
    .first().isVisible().catch(() => false)
  const send = page.locator(sendSelectors).first()
  const sendFound = (await send.count().catch(() => 0)) > 0
    && await send.isVisible().catch(() => false)
  const sendDisabled = sendFound
    ? await send.evaluate(element => element.hasAttribute('disabled')
      || element.getAttribute('aria-disabled') === 'true'
      || /(^|[\s_-])disabled([\s_-]|$)/i.test(element.className)).catch(() => false)
    : false
  return { editorVisible, looksOut, signInVisible, sendFound, sendDisabled }
}

while (Date.now() < deadline) {
  const state = await loginState()
  const loggedIn = state.editorVisible && !state.looksOut && !state.signInVisible
    && (!state.sendFound || !state.sendDisabled)
  if (loggedIn) {
    detected = true
    console.log('检测到已登录对话页，正在保存登录态...')
    await page.waitForTimeout(3_000)
    break
  }
  if (Date.now() - lastLogAt > 15_000) {
    lastLogAt = Date.now()
    console.log('仍在等待登录...（当前：'
      + `输入框=${state.editorVisible ? '可见' : '不可见'}`
      + `，登录入口=${state.signInVisible ? '在' : '无'}`
      + `，发送按钮=${state.sendFound ? (state.sendDisabled ? '禁用' : '可用') : '未找到'}）`)
  }
  await page.waitForTimeout(2_000)
}

await context.close()
console.log(detected ? '已保存登录态，profile 可复用。' : '等待登录超时（10 分钟）。')
