/**
 * 强力监督锁(用户定):开启后到「最短锁定时长」结束前,应用无法被正常退出——
 * 窗口关闭仍走托盘常驻;托盘退出/App quit 一律拦截;时长内用户自己解不开,
 * 唯一出口是保管人凭紧急解锁码命令行解锁。时长一到自动解锁,无需密码无需聊天。
 * 紧急码首次开启时生成写入文件,交给他人保管;码永久有效(跨锁定周期),用户可
 * 随时重新生成——旧码立即失效,新码重新交保管人(防自己私留副本)。锁定中禁止
 * 重新生成(新码会暴露给被锁的自己)。防君子不防小人:任务管理器杀进程挡不住,
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

/** tutor_events 留痕(表未迁移时静默)。 */
function logEvent(type: string, detail: string): void {
  try {
    db.run('INSERT INTO tutor_events (ts, type, app_name, title, detail) VALUES (?, ?, ?, ?, ?)', [
      Date.now(),
      type,
      null,
      null,
      detail
    ])
  } catch {
    // 忽略
  }
}

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
  hasRecovery: boolean
}

/** 锁定状态(查询时顺带触发到时自动解锁)。 */
export function status(): HardcoreStatus {
  maybeAutoUnlock()
  return {
    locked: state.enabled,
    unlockAfterTs: state.unlockAfterTs,
    minHours: state.minHours,
    remainingMs: state.enabled ? Math.max(0, state.unlockAfterTs - Date.now()) : 0,
    hasRecovery: !!state.recoverHash
  }
}

/** 开启强力监督:立刻生效,最短时长内无法解锁。紧急码只写入文件,不经 UI 展示。 */
export function enable(minHours: number): { ok: boolean; error?: string } {
  if (state.enabled) return { ok: false, error: '已处于强力监督中' }
  if (!(minHours > 0) || minHours > 24 * 30) return { ok: false, error: '时长需在 0-720 小时之间' }
  let code: string | null = null
  if (!state.recoverHash) {
    // 首次使用:生成紧急码并写文件;之后沿用,直到用户主动重新生成
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase()
    code = `${raw.slice(0, 4)}-${raw.slice(4)}`
    const salt = crypto.randomBytes(16).toString('hex')
    state.recoverSalt = salt
    state.recoverHash = crypto.scryptSync(normCode(code), salt, 32).toString('hex')
    writeRecoveryFile(code)
  }
  state.enabled = true
  state.unlockAfterTs = Date.now() + Math.round(minHours * 3600_000)
  state.minHours = minHours
  persist()
  startUnlockServer()
  if (!autoTimer) autoTimer = setInterval(maybeAutoUnlock, 30_000)
  return { ok: true }
}

/** 紧急码文件内容。 */
function writeRecoveryFile(code: string): void {
  fs.writeFileSync(
    recoveryFilePath(),
    [
      'Dayflow 强力监督 · 紧急解锁码',
      '',
      `解锁码:${code}`,
      '生成时间:' + new Date().toLocaleString('zh-CN'),
      '',
      '长期有效(直到被重新生成),任何时刻可用,不受最短锁定时长限制。',
      '用法(在用户的电脑上命令行执行):',
      '  node tools/dayflowctl.mjs recover ' + code,
      '',
      '请交给信得过的人保管;用户本人请删除这份本地副本,否则等于没有锁。',
      '用户可随时要求重新生成——旧码立即失效,把新码重新交给保管人即可。'
    ].join('\n')
  )
}

/** 重新生成紧急解锁码:旧码立即失效,新码只写入文件。锁定中禁止(否则用户可读文件自解)。 */
export function regenerateRecovery(): { ok: boolean; error?: string } {
  if (state.enabled) return { ok: false, error: '锁定中不能重新生成紧急码' }
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase()
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  const salt = crypto.randomBytes(16).toString('hex')
  state.recoverSalt = salt
  state.recoverHash = crypto.scryptSync(normCode(code), salt, 32).toString('hex')
  persist()
  writeRecoveryFile(code)
  logEvent('recovery-regenerate', '')
  return { ok: true }
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
  persist()
  if (autoTimer) {
    clearInterval(autoTimer)
    autoTimer = null
  }
  stopUnlockServer()
  // 紧急码保留:码永久有效,跨锁定周期复用,直到用户主动重新生成
  onUnlockedCb?.()
}

/** 到时自动解锁:锁定中且已过最短时长 → 解锁(幂等,随处可调)。 */
export function maybeAutoUnlock(): void {
  if (state.enabled && Date.now() >= state.unlockAfterTs) doUnlock()
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
  maybeAutoUnlock()
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
let autoTimer: NodeJS.Timeout | null = null

export function initHardcore(onUnlocked: () => void): void {
  onUnlockedCb = onUnlocked
  load()
  maybeAutoUnlock()
  if (state.enabled) {
    startUnlockServer()
    autoTimer = setInterval(maybeAutoUnlock, 30_000) // 跨过解锁时刻后 30s 内自动放行
  }
}

export function stopHardcore(): void {
  // 退出流程:不强停(锁定本来就不允许退出);仅供 app 真正退出时清理句柄
  if (server) {
    server.close()
    server = null
  }
}
