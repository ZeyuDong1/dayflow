/**
 * 强力监督锁(用户定):开启后到「最短锁定时长」结束前,应用无法被正常退出——
 * 窗口关闭仍走托盘常驻;托盘退出/App quit 一律拦截。唯一出口是找导师小舟聊天:
 * 到时间后她结合你的学习状态判断,同意才在回复里带上解锁指令,由系统执行。
 * 没有密码:解锁权完全由 agent 掌握。防君子不防小人:任务管理器杀进程挡不住,
 * 这是一条自我承诺装置,不是操作系统级防护。
 *
 * 状态查询端点:127.0.0.1 /status(端口+token 写在 <userData>/hardcore-unlock.json),
 * 供 CLI 查剩余时间。
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
  /** 最早可解锁时刻(启用时刻 + 最短时长) */
  unlockAfterTs: number
  minHours: number
}

let state: HardcoreState = { enabled: false, unlockAfterTs: 0, minHours: 0 }
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

/** 开启强力监督:立刻生效,最短时长内无法解锁。已开启时拒绝(先解锁才能重设)。 */
export function enable(minHours: number): { ok: boolean; error?: string } {
  if (state.enabled) return { ok: false, error: '已处于强力监督中' }
  if (!(minHours > 0) || minHours > 24 * 30) return { ok: false, error: '时长需在 0-720 小时之间' }
  state = { enabled: true, unlockAfterTs: Date.now() + Math.round(minHours * 3600_000), minHours }
  persist()
  startUnlockServer()
  return { ok: true }
}

/** 导师聊天解锁(agent 决定):时间未到一律拒绝;到了即放行——判断权在 agent 是否发出指令。 */
export function unlockByAgent(): { ok: boolean; error?: string } {
  if (!state.enabled) return { ok: false, error: 'not-locked' }
  if (Date.now() < state.unlockAfterTs) return { ok: false, error: 'too-early' }
  state.enabled = false
  persist()
  stopUnlockServer()
  onUnlockedCb?.()
  return { ok: true }
}

/** 导师聊天系统提示注入:锁定上下文(最早解锁时刻)。 */
export function chatLockContext(): string {
  if (!state.enabled) return ''
  const t = new Date(state.unlockAfterTs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `最早解锁时刻:${t}`
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
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname !== '/status' || req.method !== 'GET') return reply(404, { error: 'not-found' })
      if (u.searchParams.get('token') !== UNLOCK_TOKEN) return reply(401, { error: 'bad-credentials' })
      reply(200, { locked: state.enabled, remainingMs: Math.max(0, state.unlockAfterTs - Date.now()) })
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
