/**
 * 强力监督锁(用户定):开启后到「最短锁定时长」结束前,应用无法被正常退出——
 * 窗口关闭仍走托盘常驻;托盘退出/App quit 一律拦截;唯一出口是本机命令行:
 *   node tools/dayflowctl.mjs unlock
 * 需要密码,且必须已过 unlockAfter。防君子不防小人:任务管理器杀进程挡不住,
 * 这是一条自我承诺装置,不是操作系统级防护。
 *
 * 本机出口实现:127.0.0.1 起一个仅本机可达的 unlock HTTP 端点,端口+token 写在
 * <userData>/hardcore-unlock.json,CLI 读它调用;密码只存 scrypt 哈希。
 */
import { app, Notification } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { db } from './db'

const STORE_KEY = 'hardcore-lock'

interface HardcoreState {
  enabled: boolean
  salt: string
  passwordHash: string | null
  /** 最早可解锁时刻(启用时刻 + 最短时长) */
  unlockAfterTs: number
  minHours: number
}

let state: HardcoreState = { enabled: false, salt: '', passwordHash: null, unlockAfterTs: 0, minHours: 0 }
let server: http.Server | null = null
let onUnlockedCb: (() => void) | null = null

function load(): void {
  try {
    const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [STORE_KEY])
    if (row) state = { ...state, ...(JSON.parse(row.value) as Partial<HardcoreState>) }
  } catch {
    // 首次无记录
  }
}

function persist(): void {
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [STORE_KEY, JSON.stringify(state)])
}

export function isLocked(): boolean {
  return state.enabled
}

export interface HardcoreStatus {
  locked: boolean
  unlockAfterTs: number
  minHours: number
  remainingMs: number
}

export function status(): HardcoreStatus {
  return {
    locked: state.enabled,
    unlockAfterTs: state.unlockAfterTs,
    minHours: state.minHours,
    remainingMs: state.enabled ? Math.max(0, state.unlockAfterTs - Date.now()) : 0
  }
}

function hashOf(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex')
}

/** 开启强力监督:立刻生效,最短时长内无法解锁。已开启时拒绝(先解锁才能重设)。 */
export function enable(password: string, minHours: number): { ok: boolean; error?: string } {
  if (state.enabled) return { ok: false, error: '已处于强力监督中' }
  if (!password || password.length < 4) return { ok: false, error: '密码至少 4 位' }
  if (!(minHours > 0) || minHours > 24 * 30) return { ok: false, error: '时长需在 0-720 小时之间' }
  const salt = crypto.randomBytes(16).toString('hex')
  state = {
    enabled: true,
    salt,
    passwordHash: hashOf(password, salt),
    unlockAfterTs: Date.now() + Math.round(minHours * 3600_000),
    minHours
  }
  persist()
  startUnlockServer()
  return { ok: true }
}

/** 尝试解锁(CLI 端点调用):密码正确且已过最短时长才放行。 */
export function tryUnlock(password: string): { ok: boolean; error?: string; remainingMs?: number } {
  if (!state.enabled) return { ok: true }
  if (Date.now() < state.unlockAfterTs) {
    return { ok: false, error: 'too-early', remainingMs: state.unlockAfterTs - Date.now() }
  }
  const given = hashOf(password ?? '', state.salt)
  const expect = state.passwordHash ?? ''
  const ok =
    given.length === expect.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expect))
  if (!ok) return { ok: false, error: 'bad-credentials' }
  state.enabled = false
  state.passwordHash = null
  persist()
  stopUnlockServer()
  onUnlockedCb?.()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 本机 unlock 端点
// ---------------------------------------------------------------------------

const PREFERRED_PORT = 62224
const UNLOCK_TOKEN = crypto.randomBytes(16).toString('hex')

function unlockFilePath(): string {
  return path.join(app.getPath('userData'), 'hardcore-unlock.json')
}

function startUnlockServer(): void {
  if (server) return
  const srv = http.createServer((req, res) => {
    const body: string[] = []
    req.on('data', (c) => body.push(String(c)))
    req.on('end', () => {
      const reply = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.url !== '/unlock' || req.method !== 'POST') return reply(404, { error: 'not-found' })
      let parsed: { token?: string; password?: string } = {}
      try {
        parsed = JSON.parse(body.join('') || '{}')
      } catch {
        return reply(400, { error: 'bad-json' })
      }
      if (parsed.token !== UNLOCK_TOKEN) return reply(401, { error: 'bad-credentials' })
      const r = tryUnlock(parsed.password ?? '')
      if (r.ok) return reply(200, { ok: true })
      reply(r.error === 'too-early' ? 403 : 401, r)
    })
  })
  server = srv
  srv.on('error', () => {
    // 端口被占:换临时端口重试一次
    server = null
    if (!state.enabled) return
    srv.close()
    listenOn(0)
  })
  listenOn(PREFERRED_PORT)
}

function listenOn(port: number): void {
  if (!server) return
  server.listen(port, '127.0.0.1', () => {
    const addr = (server && server.address && server.address()) as { port: number } | null
    const real = addr && typeof addr === 'object' ? addr.port : port
    try {
      fs.writeFileSync(unlockFilePath(), JSON.stringify({ port: real, token: UNLOCK_TOKEN }))
    } catch {
      // 写不了文件时 CLI 无法发现端点,属异常环境
    }
  })
}

function stopUnlockServer(): void {
  if (server) {
    server.close()
    server = null
  }
  try {
    fs.unlinkSync(unlockFilePath())
  } catch {
    // 已不存在
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** 应用退出拦截:锁定中且非放行场景 → 阻止并提示剩余时间。 */
export function interceptQuit(e: { preventDefault: () => void }): void {
  if (!state.enabled) return
  e.preventDefault()
  const remain = Math.max(0, state.unlockAfterTs - Date.now())
  const hrs = (remain / 3600_000).toFixed(1)
  try {
    new Notification({
      title: '强力监督中',
      body: `锁定还剩约 ${hrs} 小时。到期后可用命令行 dayflowctl unlock 解锁退出。`
    }).show()
  } catch {
    // 无通知环境忽略
  }
}

/** 启动时调用:载入状态,锁定中则拉起 unlock 端点。 */
export function initHardcore(onUnlocked: () => void): void {
  onUnlockedCb = onUnlocked
  load()
  if (state.enabled) startUnlockServer()
}

export function stopHardcore(): void {
  // 退出流程:不强停(锁定本来就不允许退出);仅供 app 真正退出时清理句柄
  if (server) {
    server.close()
    server = null
  }
}
