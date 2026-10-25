import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'

/**
 * ai-memory 侧车管理器：把上游 Rust 记忆服务作为 Dayflow 的内置组件运行。
 *
 * 设计目标（对应"完整内置 + 可独立更新"）：
 * - 二进制来自 vendor/ai-memory/（开发）或 resources/ai-memory/（安装包），
 *   自带 manifest.json 版本号 —— 升级 = 换 exe + manifest，不动 Dayflow 代码。
 * - 数据目录在 Dayflow 的 userData 下（dayflow-memory/），升级二进制不丢记忆。
 * - 服务崩溃自动拉起（指数退避），应用退出时优雅关停。
 */

const START_TIMEOUT_MS = 15_000
const MAX_RESTARTS = 5

export interface MemoryServerInfo {
  running: boolean
  port: number
  dataDir: string
  binaryPath: string
  version: string
  lastError: string | null
}

let child: ChildProcess | null = null
let port = 0
let restarts = 0
let stopping = false
let lastError: string | null = null
let readyWaiters: ((ok: boolean) => void)[] = []
let healthTimer: NodeJS.Timeout | null = null

function binaryPath(): string {
  // 打包后 extraResources 放在 process.resourcesPath/ai-memory/；
  // 开发期在仓库的 vendor/ai-memory/。
  const candidates = [
    path.join(process.resourcesPath ?? '', 'ai-memory', 'ai-memory.exe'),
    path.join(app.getAppPath(), 'vendor', 'ai-memory', 'ai-memory.exe')
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return candidates[1]
}

function binaryVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(path.dirname(binaryPath()), 'manifest.json'), 'utf-8')
    )
    return String(manifest.version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

export function memoryDataDir(): string {
  return path.join(app.getPath('userData'), 'dayflow-memory')
}

/** 选一个空闲端口，避免与用户机器上已有的 ai-memory 服务冲突。 */
async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = require('net') as typeof import('net')
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (p ? resolve(p) : reject(new Error('no port'))))
    })
    srv.on('error', reject)
  })
}

async function waitForHealth(p: number, timeoutMs = START_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/healthz`, {
        signal: AbortSignal.timeout(1000)
      })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function settleWaiters(ok: boolean): void {
  const waiters = readyWaiters
  readyWaiters = []
  for (const w of waiters) w(ok)
}

export async function startMemoryServer(): Promise<boolean> {
  if (child) return true
  stopping = false

  const exe = binaryPath()
  if (!fs.existsSync(exe)) {
    lastError = `ai-memory 二进制缺失（${exe}）。运行 npm run fetch-ai-memory 下载。`
    console.warn('[memory] ' + lastError)
    settleWaiters(false)
    return false
  }

  const dataDir = memoryDataDir()
  fs.mkdirSync(dataDir, { recursive: true })

  // init 是幂等的：建目录布局 + 首次生成 bearer token。
  await new Promise<void>((resolve) => {
    const init = spawn(exe, ['init', '--data-dir', dataDir], { windowsHide: true })
    init.on('exit', () => resolve())
    init.on('error', () => resolve())
  })

  port = await pickPort()
  child = spawn(exe, ['serve', '--transport', 'http', '--data-dir', dataDir], {
    windowsHide: true,
    env: { ...process.env, AI_MEMORY_BIND: `127.0.0.1:${port}` }
  })
  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line) console.warn('[memory]', line.split('\n').slice(-2).join(' | '))
  })
  child.on('exit', (code) => {
    child = null
    if (stopping) return
    lastError = `ai-memory 退出（code ${code}）`
    if (healthTimer) clearTimeout(healthTimer)
    // 指数退避自动拉起
    if (restarts < MAX_RESTARTS) {
      const delay = Math.min(30_000, 1000 * 2 ** restarts)
      restarts++
      console.warn(`[memory] restarting in ${delay}ms (attempt ${restarts})`)
      healthTimer = setTimeout(() => void startMemoryServer(), delay)
    } else {
      console.error('[memory] gave up restarting after', MAX_RESTARTS, 'attempts')
      settleWaiters(false)
    }
  })

  const ok = await waitForHealth(port)
  if (ok) {
    restarts = 0
    lastError = null
    console.log(`[memory] ai-memory ${binaryVersion()} ready on :${port}`)
  } else {
    lastError = 'ai-memory 启动超时'
    console.warn('[memory] health check timed out')
  }
  settleWaiters(ok)
  return ok
}

export function stopMemoryServer(): void {
  stopping = true
  if (healthTimer) clearTimeout(healthTimer)
  if (child) {
    child.removeAllListeners('exit')
    child.kill()
    child = null
  }
}

export function memoryServerInfo(): MemoryServerInfo {
  return {
    running: !!child,
    port,
    dataDir: memoryDataDir(),
    binaryPath: binaryPath(),
    version: binaryVersion(),
    lastError
  }
}

/** 记忆服务的访问凭据：init 生成的 root bearer token。 */
export function memoryAuthToken(): string {
  try {
    return fs.readFileSync(path.join(memoryDataDir(), 'auth-tokens', 'default'), 'utf-8').trim()
  } catch {
    return ''
  }
}
