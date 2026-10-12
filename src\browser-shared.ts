/**
 * 浏览器通道公共助手：DeepSeek / Kimi / GLM 三条通道共享的页面操作。
 *
 * @module dsh-deepseek-web/browser-shared
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const KEEPER_FILE = fileURLToPath(new URL('../tools/browser-keeper.mjs', import.meta.url))

/** 输入区候选选择器（textarea / contenteditable / role=textbox）。 */
export const EDITOR_CANDIDATES = [
  'textarea',
  'div[contenteditable="true"]',
  'div[contenteditable="plaintext-only"]',
  'div[role="textbox"]',
  '[data-lexical-editor="true"]',
]

export function locateEditor(page: Page): Locator {
  return page.locator(EDITOR_CANDIDATES.join(', ')).filter({ visible: true }).last()
}

/** 网页端“发送过于频繁/稍后重试”一类频控提示的匹配模式。 */
export const RATE_LIMIT_PATTERN = /过于频繁|太频繁|发送太快|发送太快了|请.{0,4}稍后.{0,4}(重试|再试)|稍后再试|操作频繁|请求过于|too\s+(many|frequent)|rate[._\s-]?limit(?:ed)?|try\s+again\s+(later|soon)/i

/** 判断一段文本（toast 文案或响应体）是否是频控提示。 */
export function looksLikeRateLimitText(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text)
}

/**
 * 页面里是否正显示频控 toast。
 *
 * 只看“短小可见”的叶子元素（toast 的典型形态），并排除输入区本身——
 * 避免把用户/协议文本里恰好包含“请稍后重试”的正文误判成频控。
 */
export async function hasRateLimitToast(page: Page): Promise<boolean> {
  // evaluate 回调无法闭包模块常量，把模式源作为参数传入，保证单一事实来源
  return await page.evaluate(patternSource => {
    const pattern = new RegExp(patternSource, 'i')
    const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'))
    const elements = Array.from(document.querySelectorAll('div, span, p, section, aside')) as HTMLElement[]
    for (const element of elements) {
      if (!element.isConnected) continue
      if (editors.some(editor => editor.contains(element))) continue
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
      const text = (element.textContent ?? '').trim()
      if (text.length === 0 || text.length > 120) continue
      if (element.childElementCount > 2) continue
      if (pattern.test(text)) return true
    }
    return false
  }, RATE_LIMIT_PATTERN.source).catch(() => false)
}

export async function ensureChatPage(page: Page, url: string): Promise<void> {
  const current = page.url()
  if (!current.startsWith(new URL(url).origin)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  } else {
    await page.bringToFront()
  }
}

export async function looksLoggedOut(page: Page, markers: readonly string[] = ['sign_in', 'sign-in', 'login', 'auth']): Promise<boolean> {
  const current = new URL(page.url())
  const editorVisible = await locateEditor(page).isVisible().catch(() => false)
  if (editorVisible) return false
  return markers.some(marker => current.pathname.includes(marker) || current.search.includes(marker))
}

/**
 * 发送控件是否处于不可用状态。
 *
 * 登录墙的典型形态之一：输入框可见、也能填入文字，但发送按钮是 disabled
 * （chat.z.ai 未登录时正是如此），表现是“填进去了、回车/点发送都没反应”。
 * 找不到发送控件时返回 false（例如只认回车的站点），不误判正常页面。
 */
export async function looksSendBlocked(page: Page): Promise<boolean> {
  const control = page.locator([
    'button[class*="sendMessage" i]',
    'button[aria-label*="发送"]',
    'button[aria-label*="send" i]',
    'button[title*="发送"]',
    'button[title*="send" i]',
    '[role="button"][aria-label*="发送"]',
    '[role="button"][aria-label*="send" i]',
  ].join(', ')).first()
  if ((await control.count().catch(() => 0)) === 0) return false
  if (!(await control.isVisible().catch(() => false))) return false
  return await control.evaluate(element => element.hasAttribute('disabled')
    || element.getAttribute('aria-disabled') === 'true'
    || /(^|[\s_-])disabled([\s_-]|$)/i.test(element.className)).catch(() => false)
}

/**
 * 登录墙判定：URL 命中登录标记，或“输入框可见 + 页面有登录入口 + 发送控件被禁用”。
 *
 * 只按 URL 判断会漏掉 chat.z.ai 这类站点：未登录时停在首页、输入框照样可见，
 * 直到用户点发送才发现发不出去。把“发不出去”的信号也纳入判定后，通道可以
 * 立刻抛出“请先登录”的明确错误，而不是让用户等满一轮超时。
 */
export async function looksLoginWall(
  page: Page,
  markers: readonly string[] = ['sign_in', 'sign-in', 'login', 'auth', 'passport'],
): Promise<boolean> {
  const current = new URL(page.url())
  if (markers.some(marker => current.pathname.includes(marker) || current.search.includes(marker))) return true
  const editorVisible = await locateEditor(page).isVisible().catch(() => false)
  if (!editorVisible) return false
  const signInVisible = await page
    .getByText(/^\s*(登录|登入|立即登录|Sign in|Sign in \/ Sign up|Log in|Login)\s*$/i)
    .first()
    .isVisible()
    .catch(() => false)
  if (!signInVisible) return false
  return await looksSendBlocked(page)
}

/**
 * 尝试点击“开启新对话/New chat”入口。返回是否成功触发点击。
 *
 * 全自动模式下 DeepSeek 标签页常处于后台，`locator.click()` 依赖元素可命中
 * （visible/stable/receives events），后台标签页里侧栏可能未布局，点击会静默失败，
 * 从而沿用上一次网页对话。因此除定位器点击外，追加页面内原生 DOM 点击兜底：
 * 它不要求标签页在前台，也不要求元素可命中。
 */
export async function bestEffortNewChat(page: Page): Promise<boolean> {
  const labels = ['开启新对话', '新建对话', '新对话', '新话题', 'New chat', 'New Chat', 'New topic']
  for (const label of labels) {
    const candidate = page.getByText(label, { exact: true }).first()
    if (await candidate.isVisible().catch(() => false)) {
      const clicked = await candidate.click({ timeout: 3_000 }).then(() => true).catch(() => false)
      if (clicked) return true
    }
  }
  const roleButton = page.getByRole('button', { name: /新建对话|新对话|新话题|New chat|New topic/i }).first()
  if (await roleButton.isVisible().catch(() => false)) {
    const clicked = await roleButton.click({ timeout: 3_000 }).then(() => true).catch(() => false)
    if (clicked) return true
  }
  return await page.evaluate((texts: string[]) => {
    const norm = (value: string | null | undefined): string => (value ?? '').replace(/\s+/gu, ' ').trim()
    const elements = Array.from(document.querySelectorAll('button, a, [role="button"], div, span')) as HTMLElement[]
    for (const label of texts) {
      const exact = elements.find(el => norm(el.textContent) === label)
      if (exact) { exact.click(); return true }
    }
    for (const label of texts) {
      const partial = elements.find(el => {
        const aria = norm(el.getAttribute('aria-label'))
        const title = norm(el.getAttribute('title'))
        const text = norm(el.textContent)
        return aria.includes(label) || title.includes(label)
          || (text.includes(label) && text.length <= label.length + 4)
      })
      if (partial) { partial.click(); return true }
    }
    return false
  }, labels).catch(() => false)
}

export interface TitleMarkerState {
  original?: string
}

/** 用标题前缀提示当前状态（等待人工点击/生成中/需要选择）。 */
export async function markPageTitle(
  page: Page,
  marker: string | undefined,
  state: TitleMarkerState,
): Promise<void> {
  if (state.original === undefined) {
    state.original = await page.title()
  }
  const clean = state.original.replace(/^\[[^\]]*\]\s*/u, '')
  await page.evaluate(({ title, prefix }) => {
    document.title = prefix ? `${prefix} ${title}` : title
  }, { title: clean, prefix: marker }).catch(() => {})
}

/** 启动/复用脱离本进程的浏览器常驻守护。 */
export function spawnKeeper(options: { profileDir: string; port: number; url: string }): void {
  spawn(process.execPath, [
    KEEPER_FILE,
    '--profile', options.profileDir,
    '--port', String(options.port),
    '--url', options.url,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
}

export interface ManagedBrowserConnection {
  browser: Browser
  context: BrowserContext
  /** 浏览器启动器句柄；Edge/Chrome 可能在启动后把窗口交给子进程。 */
  process: ChildProcess
  /** 实际分配给本次 managed 浏览器的 CDP 端口。 */
  port: number
}

function browserCandidates(channel: 'msedge' | 'chrome'): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    if (channel === 'msedge') {
      return [
        path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    }
    return [
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return channel === 'msedge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  return channel === 'msedge'
    ? ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
}

function resolveBrowserExecutable(channel: 'msedge' | 'chrome'): string | undefined {
  return browserCandidates(channel).find(candidate => existsSync(candidate))
}

/** 选择 preferredPort；被占用时改用系统分配的本地空闲端口。 */
async function findAvailablePort(preferredPort: number): Promise<number> {
  const probe = (port: number): Promise<number | undefined> => new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(undefined))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const selected = typeof address === 'object' && address ? address.port : undefined
      server.close(() => resolve(selected))
    })
  })
  return await probe(preferredPort) ?? await probe(0) ?? preferredPort
}

/**
 * 启动插件自有的真实 Edge/Chrome，再通过 CDP 连接。
 *
 * 这里刻意不使用 Playwright 的 launchPersistentContext：直接启动用户安装的
 * 浏览器可以避免 Playwright 自动注入的启动参数，同时仍保留独立 profile 和
 * 可控的浏览器生命周期。
 */
export async function launchManagedBrowser(options: {
  channel: 'msedge' | 'chrome'
  profileDir: string
  preferredPort: number
  url: string
  label: string
}): Promise<ManagedBrowserConnection> {
  const executable = resolveBrowserExecutable(options.channel)
  if (!executable) {
    throw new LlmError(
      `${options.label}: 找不到 ${options.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'} 可执行文件。`,
      'BROWSER_NOT_FOUND',
    )
  }
  const port = await findAvailablePort(options.preferredPort)
  const args = [
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    ...(options.channel === 'msedge' ? ['--disable-features=msEdgeSidebarV2'] : []),
  ]
  const child = spawn(executable, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  })
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    try {
      const browser = await chromium.connectOverCDP(endpoint)
      const context = browser.contexts()[0]
      if (context) return { browser, context, process: child, port }
      await browser.close().catch(() => {})
    } catch {
      // 浏览器启动器和 CDP 服务需要一点时间，继续等待。
    }
  }
  child.kill()
  throw new LlmError(
    `${options.label}: ${options.channel} 已启动，但 CDP ${port} 在 60 秒内未就绪。`,
    'BROWSER_MANAGED_START_FAILED',
  )
}

/** 连接（必要时拉起守护）CDP 浏览器。 */
export async function connectBrowser(options: {
  port: number
  profileDir: string
  url: string
  autoStartKeeper: boolean
  label: string
}): Promise<{ browser: Browser; context: BrowserContext }> {
  const endpoint = `http://127.0.0.1:${options.port}`
  try {
    const browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    if (!context) throw new LlmError(`${options.label}: CDP 浏览器没有可用 context`, 'BROWSER_ATTACH_FAILED')
    return { browser, context }
  } catch (error) {
    if (!options.autoStartKeeper) throw error
    spawnKeeper({ profileDir: options.profileDir, port: options.port, url: options.url })
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      try {
        const browser = await chromium.connectOverCDP(endpoint)
        const context = browser.contexts()[0]
        if (context) return { browser, context }
      } catch {
        // 继续等待守护把浏览器拉起
      }
    }
    throw new LlmError(
      `${options.label}: 无法连接浏览器常驻进程（CDP ${options.port} 60 秒内未就绪）。`,
      'BROWSER_ATTACH_FAILED',
    )
  }
}

/** 默认的浏览器 profile 目录（工作区外）。 */
export function defaultProfileDir(name: string): string {
  const appDataRoot = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(appDataRoot, 'DshDeepSeekWeb', name)
}

/**
 * 把 dsh 宿主窗口提到最前（“放在屏幕最上端”）。
 *
 * 仅在 Windows 上生效：用 PowerShell 枚举顶层窗口，按进程名或标题正则
 * 匹配第一个可见窗口并调用 SetForegroundWindow。找不到匹配时静默返回 false，
 * 不抛异常，避免影响主流程。
 */
export async function focusDshWindow(options: {
  processNames?: readonly string[]
  titlePattern?: string
}): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const names = (options.processNames ?? []).map(name => String(name).trim()).filter(name => name.length > 0)
  const pattern = (options.titlePattern ?? '').trim()
  if (names.length === 0 && !pattern) return false
  const script = buildFocusScript(names, pattern)
  return await new Promise<boolean>(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      console.warn('[deepseek-web] focusDshWindow: 聚焦脚本执行超时（5s），已放弃并继续主流程。')
      resolve(false)
    }, 5_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      console.warn('[deepseek-web] focusDshWindow: 无法启动 powershell.exe：', error.message)
      resolve(false)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const ok = out.trim() === '1'
      if (!ok) {
        console.warn(
          '[deepseek-web] focusDshWindow: 未匹配到 dsh 窗口，已静默跳过。'
          + ` 进程名候选=${JSON.stringify(names)} 标题正则=${JSON.stringify(pattern)}`,
        )
      }
      resolve(ok)
    })
  })
}

/**
 * 生成聚焦脚本。
 *
 * 注意：窗口枚举与匹配全部放在 C# 内完成（包括用 .NET 的 Process 取进程名），
 * 不依赖 PowerShell 委托回调的 runspace 与 $script: 作用域——后者在
 * EnumWindows 回调里写回外层变量并不可靠，会静默失败。
 */
function buildFocusScript(processNames: readonly string[], titlePattern: string): string {
  const namesJson = JSON.stringify(processNames)
  const patternJson = JSON.stringify(titlePattern)
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Text;',
    'using System.Diagnostics;',
    'using System.Runtime.InteropServices;',
    'public class DshFocus {',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  public static IntPtr Target = IntPtr.Zero;',
    '  static string[] Names = new string[0];',
    '  static string Pattern = "";',
    '  public static string Find(string[] names, string pattern) {',
    '    Names = names ?? new string[0];',
    '    Pattern = pattern ?? "";',
    '    Target = IntPtr.Zero;',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
    '      if (!IsWindowVisible(h)) return true;',
    '      int len = GetWindowTextLength(h);',
    '      if (len <= 0) return true;',
    '      var sb = new StringBuilder(len + 1);',
    '      GetWindowText(h, sb, sb.Capacity);',
    '      string text = sb.ToString();',
    '      uint pid = 0;',
    '      GetWindowThreadProcessId(h, out pid);',
    '      string pname = "";',
    '      try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {}',
    '      bool hit = false;',
    '      foreach (var n in Names) {',
    '        if (!string.IsNullOrEmpty(n) && string.Equals(n, pname, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }',
    '      }',
    '      if (!hit && Pattern.Length > 0) {',
    '        try { if (System.Text.RegularExpressions.Regex.IsMatch(text, Pattern)) hit = true; } catch {}',
    '      }',
    '      if (hit) { Target = h; return false; }',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return Target.ToString();',
    '  }',
    '  public static void Activate() {',
    '    ShowWindow(Target, 9);',
    '    SetForegroundWindow(Target);',
    '  }',
    '}',
    '"@',
    `[string[]]$names = @(ConvertFrom-Json '${namesJson}')`,
    `[string]$pattern = [string](ConvertFrom-Json '${patternJson}')`,
    '$found = [DshFocus]::Find($names, $pattern)',
    'if ($found -ne "0") {',
    '  [DshFocus]::Activate()',
    "  Write-Output '1'",
    '} else {',
    "  Write-Output '0'",
    '}',
  ].join('\n')
}

/**
 * 设置插件浏览器窗口是否置顶（屏幕最上方）。
 *
 * 仅 Windows 生效：按命令行里的 profile 目录特征定位插件专用的 msedge 窗口，
 * SetWindowPos(HWND_TOPMOST/NOTOPMOST)，置顶时同时 SetForegroundWindow。
 * 进程匹配放在 PowerShell 管道里完成（Get-CimInstance 提供 CommandLine，
 * Get-Process 提供 MainWindowHandle），只把句柄交给 P/Invoke。
 * 找不到匹配时静默返回 false，不影响主流程。
 */
export async function setBrowserWindowTopmost(options: {
  profileDir: string
  topmost: boolean
}): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const marker = String(options.profileDir ?? '').trim()
  if (!marker) return false
  const markerJson = JSON.stringify(marker)
  const topmostJson = JSON.stringify(options.topmost === true)
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `[string]$marker = [string](ConvertFrom-Json '${markerJson}')`,
    `[bool]$topmost = [bool](ConvertFrom-Json '${topmostJson}')`,
    `$pattern = '*' + $marker + '*'`,
    `$ids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like $pattern } | ForEach-Object { $_.ProcessId })`,
    'if ($ids.Count -eq 0) { Write-Output "0"; exit }',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DshTop {',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  public static void Apply(IntPtr h, bool topmost) {',
    '    IntPtr after = topmost ? new IntPtr(-1) : new IntPtr(-2);',
    '    SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '    if (topmost) SetForegroundWindow(h);',
    '  }',
    '}',
    '"@',
    '$hit = 0',
    'Get-Process -Name msedge | Where-Object { $ids -contains $_.Id -and $_.MainWindowHandle -ne 0 } | ForEach-Object {',
    '  if ([DshTop]::IsWindowVisible($_.MainWindowHandle)) { [DshTop]::Apply($_.MainWindowHandle, $topmost); $hit++ }',
    '}',
    'if ($hit -gt 0) { Write-Output "1" } else { Write-Output "0" }',
  ].join('\n')
  return await new Promise<boolean>(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      console.warn('[deepseek-web] setBrowserWindowTopmost: 脚本执行超时（5s），已放弃并继续主流程。')
      resolve(false)
    }, 5_000)
    child.stdout?.on('data', chunk => { out += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      console.warn('[deepseek-web] setBrowserWindowTopmost: 无法启动 powershell.exe：', error.message)
      resolve(false)
    })
    child.on('close', code => {
      clearTimeout(timer)
      // $true 路径由参数写死（topmost 由调用方决定），这里只关心是否命中窗口
      resolve(code === 0 && out.trim() === '1')
    })
  })
}
