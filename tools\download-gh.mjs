/**
 * 通过已登录的常驻 Edge 下载 GitHub CLI 便携包（避开 WinHTTP 代理限制）。
 *
 * 用法：node tools/download-gh.mjs
 * 产物：%LOCALAPPDATA%\Programs\gh\gh.zip
 */

import { chromium } from 'playwright-core'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const targetDir = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'gh')
await mkdir(targetDir, { recursive: true })
const targetZip = path.join(targetDir, 'gh.zip')

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const context = browser.contexts()[0]
const page = await context.newPage()

try {
  await page.goto('https://github.com/cli/cli/releases/latest', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const tagUrl = page.url()
  console.log('release page:', tagUrl)

  const tag = tagUrl.split('/').at(-1)
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error(`无法从 ${tagUrl} 解析版本号`)
  const version = tag.slice(1)
  const links = await page.locator('a[href*="windows_amd64.zip"]').evaluateAll(items => items.map(item => item.href))
  const assetUrl = links[0]
    ?? `https://github.com/cli/cli/releases/download/${tag}/gh_${version}_windows_amd64.zip`
  console.log('asset:', assetUrl)

  const downloadPromise = context.waitForEvent('download', { timeout: 180_000 })
  await page.goto(assetUrl, { waitUntil: 'commit', timeout: 60_000 }).catch(() => {})
  const download = await downloadPromise
  await download.saveAs(targetZip)
  const info = await stat(targetZip)
  console.log(`saved: ${targetZip} (${Math.round(info.size / 1024 / 1024)} MB)`)
} catch (error) {
  // 下载可能已被浏览器接管到默认下载目录，做一次兜底查找
  const downloads = path.join(process.env.USERPROFILE ?? '', 'Downloads')
  const entries = await readdir(downloads).catch(() => [])
  const candidate = entries.filter(name => /^gh_.*windows_amd64\.zip$/.test(name)).sort().at(-1)
  if (candidate) {
    console.log(`download event unavailable; found in Downloads: ${path.join(downloads, candidate)}`)
  } else {
    console.error('ERR', error.message)
    process.exitCode = 1
  }
} finally {
  await page.close().catch(() => {})
  await browser.close()
}
