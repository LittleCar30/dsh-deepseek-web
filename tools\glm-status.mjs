/**
 * GLM 审核通道体检（诊断工具）。
 *
 * 体检项：
 * - 常驻浏览器（CDP，默认 9335）是否可达；不可达时按插件逻辑拉起 keeper；
 * - chat.z.ai 是否已登录：登录入口可见 + 发送按钮禁用 = 登录墙；
 * - 输入框 / 发送按钮的就绪状态；
 * - 可选 `--turn`：真实填一条校准消息并发起发送，抓 SSE 样本到 calibration/。
 *
 * 用法：
 *   node tools/glm-status.mjs            # 只体检（默认）
 *   node tools/glm-status.mjs --turn     # 体检 + 真实往返，产出 glm-chat-*.bin
 *   node tools/glm-status.mjs --close    # 体检后停 keeper 并关窗口
 *
 * 首次使用 GLM 审核前应先 `open-login-glm.mjs` 登录；登录后跑一次 `--turn`
 * 即为协议校准（`glm-parse-check.ts` 会用该样本验证解析器）。
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const keeperFile = fileURLToPath(new URL('./browser-keeper.mjs', import.meta.url))
const appDataRoot = process.env.LOCALAPPDATA
  ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const profileDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'glm-profile')
const calibrationDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'calibration')
const port = Number(process.env.GLM_DEBUG_PORT ?? 9335)
const url = process.env.GLM_URL ?? 'https://chat.z.ai/'
const endpoint = `http://127.0.0.1:${port}`

const shouldTurn = process.argv.includes('--turn')
const shouldClose = process.argv.includes('--close')
const editorSelectors = [
  'textarea',
  'div[contenteditable="true"]',
  'div[contenteditable="plaintext-only"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
].join(', ')
const loginMarkers = ['sign_in', 'sign-in', 'login', 'auth', 'passport']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function attach() {
  const browser = await chromium.connectOverCDP(endpoint)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP 浏览器没有可用 context')
  return { browser, context }
}

async function sendButtonState(page) {
  const control = page.locator([
    'button[class*="sendMessage" i]',
    'button[aria-label*="发送"]',
    'button[aria-label*="send" i]',
    'button[title*="发送"]',
    'button[title*="send" i]',
  ].join(', ')).first()
  if ((await control.count().catch(() => 0)) === 0) return { found: false, disabled: false }
  const visible = await control.isVisible().catch(() => false)
  const disabled = await control.evaluate(element => element.hasAttribute('disabled')
    || element.getAttribute('aria-disabled') === 'true'
    || /(^|[\s_-])disabled([\s_-]|$)/i.test(element.className)).catch(() => false)
  return { found: visible, disabled }
}

const report = {
  profileDir,
  profileExists: existsSync(profileDir),
  keeperSpawned: false,
  cdpAttached: false,
  pageUrl: '',
  pageTitle: '',
  editorVisible: false,
  sendButton: { found: false, disabled: false },
  loginMarkerHit: false,
  cookies: 0,
}

let connection
try {
  connection = await attach()
  console.log('[glm-status] CDP 已就绪（keeper 已在运行）')
} catch {
  console.log(`[glm-status] CDP ${port} 未就绪，按插件逻辑拉起 keeper…`)
  spawn(process.execPath, [
    keeperFile,
    '--profile', profileDir,
    '--port', String(port),
    '--url', url,
  ], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  report.keeperSpawned = true
  for (let attempt = 0; attempt < 60 && !connection; attempt++) {
    await sleep(1_000)
    connection = await attach().catch(() => undefined)
  }
  if (!connection) {
    console.log(JSON.stringify({ ...report, error: `CDP ${port} 60 秒内未就绪` }, null, 2))
    process.exit(1)
  }
}
report.cdpAttached = true

const { browser, context } = connection
const page = context.pages().find(item => item.url().startsWith(new URL(url).origin))
  ?? context.pages()[0]
  ?? await context.newPage()
if (!page.url().startsWith(new URL(url).origin)) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
}
await page.waitForTimeout(2_000)

report.pageUrl = page.url()
report.pageTitle = await page.title().catch(() => '')
report.editorVisible = await page.locator(editorSelectors).filter({ visible: true }).last()
  .isVisible().catch(() => false)
report.sendButton = await sendButtonState(page)
report.loginMarkerHit = loginMarkers.some(marker => {
  const current = new URL(page.url())
  return current.pathname.includes(marker) || current.search.includes(marker)
})
report.cookies = (await context.cookies().catch(() => [])).length
const signInVisible = await page.getByText(/^\s*(登录|登入|立即登录|Sign in|Log in|Login)\s*$/i).first()
  .isVisible().catch(() => false)
report.signInControlVisible = signInVisible
report.loggedIn = report.editorVisible && !report.loginMarkerHit && !(signInVisible && report.sendButton.disabled)

console.log(JSON.stringify(report, null, 2))

if (!report.loggedIn) {
  console.log('[glm-status] 结论：GLM 通道不可用（未登录）。'
    + '请运行 node tools/open-login-glm.mjs 完成一次登录后重试。')
  if (shouldTurn) console.log('[glm-status] 已跳过 --turn：未登录时发送按钮禁用，消息发不出去。')
}

if (shouldTurn && report.loggedIn) {
  const responsePromise = page.waitForResponse(
    response => response.request().method() === 'POST' && /chat\/completions/i.test(response.url()),
    { timeout: 180_000 },
  )
  const editor = page.locator(editorSelectors).filter({ visible: true }).last()
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText('[校准探测] 请只回复：OK')
  await page.waitForTimeout(600)
  if ((await sendButtonState(page)).disabled) {
    console.log('[glm-status] 发送按钮仍为禁用，跳过发送（请检查登录态）。')
  } else {
    await page.keyboard.press('Enter')
    const response = await responsePromise.catch(() => undefined)
    if (!response) {
      console.log('[glm-status] 180 秒内没有收到 chat/completions 响应（可能回车未触发发送）。')
    } else {
      await response.finished().catch(() => {})
      const body = await response.body().catch(() => Buffer.alloc(0))
      mkdirSync(calibrationDir, { recursive: true })
      const sampleFile = path.join(calibrationDir, `glm-chat-${Date.now()}.bin`)
      writeFileSync(sampleFile, body)
      const deltas = []
      for (const line of body.toString('utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const event = JSON.parse(payload)
          if (event.type === 'chat:completion' && typeof event.data?.delta_content === 'string') {
            deltas.push(event.data.delta_content)
          }
        } catch {
          // 非 JSON 的 data 行（心跳/注释）跳过
        }
      }
      console.log(JSON.stringify({
        turnUrl: response.url(),
        status: response.status(),
        bytes: body.length,
        sampleFile,
        parsedText: deltas.join(''),
      }, null, 2))
    }
  }
}

if (shouldClose) {
  // keeper 每 10 秒会重新拉起浏览器，必须先停 keeper 再关窗口
  const script = [
    "$pattern = '*' + 'browser-keeper.mjs' + '*glm-profile' + '*'",
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine -like $pattern } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }',
  ].join('\n')
  const killed = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()
  console.log(killed ? `[glm-status] 已停止 GLM keeper: ${killed.split(/\s+/).join(', ')}` : '[glm-status] 未发现 GLM keeper 进程')
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  console.log('[glm-status] 已关闭 GLM 浏览器窗口')
}

process.exit(report.loggedIn ? 0 : 2)
