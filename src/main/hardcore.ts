/**
 * 强力监督锁(用户定):开启后到「最短锁定时长」结束前,应用无法被正常退出——
 * 窗口关闭仍走托盘常驻;托盘退出/App quit 一律拦截。唯一出口是找导师小舟聊天:
 * 到时间后她结合你的学习状态判断,同意才在回复里带上解锁指令,由系统执行。
 * 另留一条绝对出口:开启时生成紧急解锁码写入文件,交给他人保管;凭码任何时刻
 * (不受最短时长限制)可命令行解锁,用于 agent 误判或真实紧急情况。
 * 防君子不防小人:任务管理器杀进程挡不住,这是一条自我承诺装置,不是操作系统级防护。
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
  /** 紧急解锁码(交他人保管):只存哈希;明文只出现在生成时的紧急码文件里 */
  recoverSalt: string
  recoverHash: string | null
}

let state: HardcoreState = { enabled: false, unlockAfterTs: 0, minHours: 0, recoverSalt: '', recoverHash: null }
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

/** 开启强力监督:立刻生效,最短时长内无法解锁。返回一次性展示的紧急解锁码。 */
export function enable(minHours: number): { ok: boolean; error?: string; recoveryCode?: string } {
  if (state.enabled) return { ok: false, error: '已处于强力监督中' }
  if (!(minHours > 0) || minHours > 24 * 30) return { ok: false, error: '时长需在 0-720 小时之间' }
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase()
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  const salt = crypto.randomBytes(16).toString('hex')
  state = {
    enabled: true,
    unlockAfterTs: Date.now() + Math.round(minHours * 3600_000),
    minHours,
    recoverSalt: salt,
    recoverHash: crypto.scryptSync(normCode(code), salt, 32).toString('hex')
  }
  persist()
  startUnlockServer()
  try {
    fs.writeFileSync(
      recoveryFilePath(),
      [
        'Dayflow 强力监督 · 紧急解锁码',
        '',
        `解锁码:${code}`,
        '生成时间:' + new Date().toLocaleString('zh-CN'),
        `最短锁定至:${new Date(state.unlockAfterTs).toLocaleString('zh-CN')}`,
        '',
        '用法(在用户的电脑上命令行执行):',
        '  node tools/dayflowctl.mjs recover ' + code,
        '',
        '任何时刻可用,不受最短锁定时长限制——请交给信得过的人保管;',
        '用户本人请删除这份本地副本,否则等于没有锁。',
        '',
        '常规出口(无需此码):最短时长结束后,在 Dayflow 对话页找导师小舟聊天,她同意即解锁。'
      ].join('\n')
    )
  } catch {
    // 文件写失败不阻断开启;码仍会在设置面板一次性展示
  }
  return { ok: true, recoveryCode: code }
}

function normCode(code: string): string {
  return (code ?? '').replace(/[-\s]/g, '').toUpperCase()
}

function recoveryFilePath(): string {
  return path.join(app.getPath('userData'), 'hardcore-recovery.txt')
}

/** 紧急解锁(交他人保管的码):任何时刻可用,不受最短时长限制。 */
export function tryRecovery(code: string): { ok: boolean; error?: string } {
  if (!state.enabled) return { ok: false, error: 'not-locked' }
  const expect = state.recoverHash ?? ''
  const given = crypto.scryptSync(normCode(code), state.recoverSalt, 32).toString('hex')
  if (given.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expect))) {
    return { ok: false, error: 'bad-credentials' }
  }
  doUnlock()
  return { ok: true }
}

function doUnlock(): void {
  state.enabled = false
  state.recoverHash = null
  persist()
  stopUnlockServer()
  try {
    fs.unlinkSync(recoveryFilePath())
  } catch {
    // 已不存在
  }
  onUnlockedCb?.()
}

/** 导师聊天解锁(agent 决定):时间未到一律拒绝;到了即放行——判断权在 agent 是否发出指令。 */
export function unlockByAgent(): { ok: boolean; error?: string } {
  if (!state.enabled) return { ok: false, error: 'not-locked' }
  if (Date.now() < state.unlockAfterTs) return { ok: false, error: 'too-early' }
  doUnlock()
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
      if (u.searchParams.get('token') !== UNLOCK_TOKEN) return reply(401, { error: 'bad-credentials' })
      if (u.pathname === '/status' && req.method === 'GET') {
        return reply(200, { locked: state.enabled, remainingMs: Math.max(0, state.unlockAfterTs - Date.now()) })
      }
      if (u.pathname === '/unlock' && req.method === 'POST') {
        let parsed: { code?: string } = {}
        try {
          parsed = JSON.parse(body.join('') || '{}')
        } catch {
          return reply(400, { error: 'bad-json' })
        }
        const r = tryRecovery(parsed.code ?? '')
        return reply(r.ok ? 200 : r.error === 'bad-credentials' ? 401 : 400, r)
      }
      reply(404, { error: 'not-found' })
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
