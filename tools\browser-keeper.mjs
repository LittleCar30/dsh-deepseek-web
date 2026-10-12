/**
 * DeepSeek Web 浏览器常驻守护。
 *
 * 用法：
 *   node tools/browser-keeper.mjs
 *     --profile <user-data-dir>
 *     --port <cdp-port>       默认 9333
 *     --url  <页面地址>        默认 https://chat.deepseek.com
 *
 * 职责：
 * - 用真实 Edge（有头窗口、无自动化开关）启动/连接 chat.deepseek.com；
 * - 浏览器被意外关闭时自动重新拉起（连续失败约 100 秒后守护退出，避免无限重启）；
 * - dsh 插件通过 CDP attach 模式连接它，因此 dsh 重启不会关闭浏览器；
 * - 停机信号：profile 所在目录出现 keeper.stop 且 15 分钟内新鲜时，守护自行退出
 *   且不再重启浏览器（收到停机信号后退出，避免与桌面版关闭流程竞态）。
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const EDGE_CANDIDATES = [
  process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function findEdge() {
  return EDGE_CANDIDATES.find(existsSync)
}

function parseArgs(argv) {
  const appDataRoot = process.env.LOCALAPPDATA
    ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  const args = { profile: '', port: 9333, url: 'https://chat.deepseek.com' }
  args.profile = path.join(appDataRoot, 'DshDeepSeekWeb', 'edge-profile')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') args.profile = argv[++i] ?? ''
    else if (arg === '--port') args.port = Number(argv[++i] ?? 9333)
    else if (arg === '--url') args.url = argv[++i] ?? 'https://chat.deepseek.com'
  }
  return args
}

const opts = parseArgs(process.argv.slice(2))
const edgePath = findEdge()
if (!edgePath) {
  console.error('找不到 Microsoft Edge。请先安装 Edge 或修改 EDGE_CANDIDATES。')
  process.exit(1)
}

const endpoint = `http://127.0.0.1:${opts.port}/json/version`

// 停机信号文件：与 profile 同级（即 %LOCALAPPDATA%\DshDeepSeekWeb\keeper.stop），
// 由调用方在关闭流程开始时写入；15 分钟后自动过期删除，避免长期残留
// 影响之后手动拉起的守护。
const stopSignalFile = path.join(path.dirname(path.resolve(opts.profile)), 'keeper.stop')
const STOP_SIGNAL_TTL_MS = 15 * 60 * 1000
const MAX_CONSECUTIVE_RELAUNCH_FAILURES = 10

/** 停机信号是否新鲜；过期的顺手删掉。新鲜时守护应退出且不再重启浏览器。 */
function stopSignalFresh() {
  try {
    const stat = statSync(stopSignalFile)
    if (Date.now() - stat.mtimeMs > STOP_SIGNAL_TTL_MS) {
      rmSync(stopSignalFile, { force: true })
      return false
    }
    return true
  } catch {
    return false
  }
}

async function edgeAlive() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    const response = await fetch(endpoint, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

let edge = null

function launchEdge() {
  if (edge && !edge.killed) return edge
  console.log(`[keeper] 启动 Edge: ${edgePath}`)
  console.log(`[keeper] CDP: ${endpoint}`)
  edge = spawn(edgePath, [
    `--user-data-dir=${opts.profile}`,
    `--remote-debugging-port=${opts.port}`,
    '--no-first-run',
    '--disable-features=msEdgeSidebarV2',
    opts.url,
  ], {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  })
  // Edge 的启动器进程通常会立刻退出并把窗口交给独立浏览器进程；
  // 是否存活一律以 CDP 探测为准，不能跟随 launcher 退出。
  edge.on('exit', code => {
    console.log(`[keeper] Edge launcher 退出 (code=${code})；浏览器进程是否存活由 CDP 探测决定`)
    edge = null
  })
  return edge
}

async function main() {
  if (stopSignalFresh()) {
    console.log(`[keeper] 检测到停机信号（15 分钟内），守护退出：${stopSignalFile}`)
    console.log('[keeper] 如需再次使用浏览器，请删除该信号文件后重新运行 keeper。')
    process.exit(0)
  }
  if (await edgeAlive()) {
    console.log('[keeper] CDP 已就绪，浏览器保持常开。')
    return
  }
  launchEdge()
  // 等待 CDP 就绪
  for (let i = 0; i < 120; i++) {
    if (stopSignalFresh()) {
      console.log('[keeper] 等待 CDP 期间收到停机信号，守护退出。')
      process.exit(0)
    }
    if (await edgeAlive()) {
      console.log('[keeper] CDP 就绪，浏览器保持常开。')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  console.error('[keeper] CDP 在 120 秒内未就绪，守护退出（浏览器可能无法启动）。')
  process.exit(1)
}

// 常驻：进程不退出；浏览器意外关闭时由下面的轮询重新拉起；
// 连续多轮拉不起（如 Edge 正在更新）则退出，避免每 10 秒空转重启。
let failedRounds = 0
setInterval(async () => {
  if (stopSignalFresh()) {
    console.log('[keeper] 收到停机信号，守护退出；浏览器窗口需要单独关闭。')
    process.exit(0)
  }
  if (await edgeAlive()) {
    failedRounds = 0
    return
  }
  failedRounds += 1
  if (failedRounds >= MAX_CONSECUTIVE_RELAUNCH_FAILURES) {
    console.error(`[keeper] 连续 ${failedRounds} 轮无法拉起浏览器，守护退出。请检查 Edge 安装后重新运行 keeper。`)
    process.exit(1)
  }
  console.log('[keeper] 失去 CDP 连接，尝试重新拉起 Edge。')
  launchEdge()
}, 10_000)

process.on('SIGINT', () => {
  console.log('[keeper] 收到 SIGINT，退出守护（Edge 保持独立，不随守护关闭）。')
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.exit(0)
})

await main()
