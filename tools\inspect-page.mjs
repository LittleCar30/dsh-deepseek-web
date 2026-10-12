/**
 * 页面结构校准：复用已登录 profile，输出聊天页的关键结构，
 * 并用一条“只回复 OK”的探测消息确认网页端回复接口路径。
 *
 * 用法：node tools/inspect-page.mjs
 *
 * 消息填入后请人工点击“发送”；回复完成后脚本把观测结果写到
 * .runtime/dom-inspect.json。
 */

import { chromium } from 'playwright-core'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDataRoot = process.env.LOCALAPPDATA
  ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
const profileDir = path.join(appDataRoot, 'DshDeepSeekWeb', 'edge-profile')

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
})

const page = context.pages()[0] ?? (await context.newPage())
await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.bringToFront()
await page.waitForTimeout(2_000)

const observed = {
  url: page.url(),
  title: await page.title(),
  screenshot: '',
  editors: [],
  sendCandidates: [],
  completionResponses: [],
  completionSampleFile: '',
  createdAt: new Date().toISOString(),
}

const screenshotFile = path.join(projectRoot, '.runtime', 'page-before.png')
await page.screenshot({ path: screenshotFile, fullPage: false })
observed.screenshot = screenshotFile

// 输入区候选
const editorSelectors = [
  'textarea',
  'div[contenteditable="true"]',
  'div[contenteditable="plaintext-only"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
]
for (const selector of editorSelectors) {
  const count = await page.locator(selector).count().catch(() => 0)
  const visible = count > 0
    ? await page.locator(selector).filter({ visible: true }).count().catch(() => 0)
    : 0
  if (count > 0) observed.editors.push({ selector, count, visible })
}

// 可能的发送按钮（名称/aria/文本）
for (const name of ['发送', 'Send', '提交', 'Submit']) {
  const count = await page.getByRole('button', { name }).count().catch(() => 0)
  if (count > 0) observed.sendCandidates.push({ name, count })
}

const editor = page.locator(editorSelectors.join(', ')).filter({ visible: true }).last()
if (await editor.isVisible().catch(() => false)) {
  // 挂网络监听并填探测消息，等待人工发送
const responseInfo = []
let completionBody = ''
const responseWatcher = page.on('response', async response => {
  if (response.request().method() !== 'POST') return
  const url = response.url()
  if (!/chat|completion|conversation|generate/i.test(url)) return
  const bodyText = (await response.body().catch(() => '')).toString()
  if (/\/api\/v0\/chat\/completion/i.test(url)) completionBody = bodyText
  responseInfo.push({
    url,
    status: response.status(),
    contentType: response.headers()['content-type'] ?? '',
    bodyPreview: bodyText.slice(0, 600),
  })
})

  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText('[校准探测] 请只回复：OK')
  await page.bringToFront()
  console.log('\n已填入探测消息，请在浏览器中人工点击“发送”，等待回复结束...')

  // 等回复稳定：监听停止按钮恢复为发送按钮，最多等 5 分钟
  const done = await Promise.race([
    page.waitForTimeout(300_000).then(() => false),
    page.waitForResponse(
      response => /chat|completion|conversation|generate/i.test(response.url())
        && response.request().method() === 'POST',
      { timeout: 300_000 },
    ).then(async response => {
      await response.finished().catch(() => {})
      await page.waitForTimeout(5_000)
      return true
    }),
  ])

  if (done) {
    observed.completionResponses = responseInfo
    if (completionBody) {
      const sampleFile = path.join(projectRoot, '.runtime', 'completion-sample.txt')
      await writeFile(sampleFile, completionBody)
      observed.completionSampleFile = sampleFile
    }
  } else {
    observed.completionResponses = []
    console.log('等待回复超时（可能未人工点击发送）。')
  }
} else {
  console.log('未找到输入框：请确认已在窗口中登录并打开聊天页。')
}

const outFile = path.join(projectRoot, '.runtime', 'dom-inspect.json')
await writeFile(outFile, JSON.stringify(observed, null, 2))
console.log(`\n观测结果已写入：${outFile}`)

await context.close()
