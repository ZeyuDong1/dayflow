import { BrowserWindow, Notification, app, powerMonitor } from 'electron'
import path from 'path'
import { getSettings } from './settings'
import { todayKey } from './paths'
import { db } from './db'
import { classifyActivity, listProjects } from './projects'
import {
  getForegroundInfoSync,
  getWindowGeom,
  isWindowUsable,
  type ForegroundInfo
} from './foreground'
import { buildNudge, saveFeedbackToMemory } from './ai/tutor'
import { textComplete, resolveProvider } from './ai/providers'

/**
 * 学习监督引擎(常驻,零 token):本地规则判定当前行为是否学习,
 * 分心按升级阶梯打断:轻提醒(桌面通知,可延迟一次)→ 强打断面板 → 重复。
 *
 * 强打断面板的规格(用户定):
 * - 恰好覆盖违规 APP 的内容区,但让出顶部标题栏(关闭/最小化仍可点)
 * - 中间是小舟的话 + 一个"心理反馈"输入框
 * - 违规窗口被最小化或关闭、或切回学习,面板自动消失
 */

const TICK_MS = 3000
const OVERLAY_POLL_MS = 800

type Judge = 'learning' | 'non-learning' | 'neutral'

interface Episode {
  hwnd: number
  appName: string
  title: string
  startTs: number
  gentleSent: boolean
  postponed: boolean
  lastInterruptAt: number
}

let tickTimer: NodeJS.Timeout | null = null
let overlayTimer: NodeJS.Timeout | null = null
let episode: Episode | null = null
let breakUntil = 0
let pausedDayKey: string | null = null
let interruptWin: BrowserWindow | null = null
let lastPayload: Record<string, unknown> | null = null
let previewUntil = 0 // 预览期间 tick 不自动关面板

function logEvent(type: string, appName: string | null, title: string | null, detail: string | null): void {
  try {
    db.run('INSERT INTO tutor_events (ts, type, app_name, title, detail) VALUES (?, ?, ?, ?, ?)', [
      Date.now(),
      type,
      appName,
      title,
      detail
    ])
  } catch {
    // 表尚未迁移时忽略,不影响打断
  }
}

function isPrivate(appName: string, title: string): boolean {
  const apps = getSettings().capture.privateApps
  return apps.some(
    (p) =>
      p.trim().length > 0 &&
      (appName.toLowerCase().includes(p.trim().toLowerCase()) ||
        title.toLowerCase().includes(p.trim().toLowerCase()))
  )
}

/** 学习/分心判定:白名单优先,否则按项目效率分;未归类不打扰。 */
function judge(fg: ForegroundInfo): Judge {
  const settings = getSettings()
  if (fg.windowTitle === '学习监督') return 'neutral' // 打断面板自己
  if (/dayflow/i.test(fg.appName)) return 'neutral' // Dayflow 自身(设置/查看时间线)
  if (isPrivate(fg.appName, fg.windowTitle)) return 'neutral'
  const projectId = classifyActivity(fg.appName, fg.windowTitle)
  if (projectId === null) return 'neutral'
  const allowed = settings.tutor.allowedProjectIds
  if (allowed.includes(projectId)) return 'learning'
  if (allowed.length > 0) return 'non-learning'
  const score = listProjects().find((p) => p.id === projectId)?.productivityScore ?? 4
  return score >= 6 ? 'learning' : score <= 3 ? 'non-learning' : 'neutral'
}

// ---------------------------------------------------------------------------
// 强打断面板
// ---------------------------------------------------------------------------

function closeInterrupt(): void {
  if (overlayTimer) {
    clearInterval(overlayTimer)
    overlayTimer = null
  }
  if (interruptWin && !interruptWin.isDestroyed()) interruptWin.close()
  interruptWin = null
}

function showInterrupt(ep: Episode, geom: { left: number; top: number; width: number; height: number; titleBarHeight: number }): void {
  // 让出顶部标题栏:用户随时能点到底下 APP 的最小化/关闭
  const x = geom.left
  const y = geom.top + geom.titleBarHeight
  const w = Math.max(360, geom.width)
  const h = Math.max(260, geom.height - geom.titleBarHeight)

  if (interruptWin && !interruptWin.isDestroyed()) {
    interruptWin.setBounds({ x, y, width: w, height: h })
    if (lastPayload) interruptWin.webContents.send('supervision:interrupt', lastPayload)
    return
  }

  const win = new BrowserWindow({
    x,
    y,
    width: w,
    height: h,
    title: '学习监督',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#fffdf8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}#/interrupt`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/interrupt' })
  }
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    interruptWin = null
    if (overlayTimer) {
      clearInterval(overlayTimer)
      overlayTimer = null
    }
  })
  interruptWin = win

  // 面板与违规窗口绑定:最小化/关闭/切走 → 自动消失
  const targetHwnd = ep.hwnd
  let awayStrikes = 0
  overlayTimer = setInterval(() => {
    if (!interruptWin || interruptWin.isDestroyed()) return
    if (!isWindowUsable(targetHwnd)) {
      logEvent('interrupt-auto-close', ep.appName, ep.title, '违规窗口已最小化/关闭')
      closeInterrupt()
      return
    }
    // 预览期:只演示"最小化/关闭即消失",切走不关(方便慢慢看效果)
    if (Date.now() < previewUntil) return
    const fg = getForegroundInfoSync()
    if (!fg) return
    // 面板自己、自家主窗口拿到焦点都不算"切走";连续两次观察到第三方前台才关
    const selfOrTarget =
      fg.hwnd === targetHwnd || fg.windowTitle === '学习监督' || /dayflow/i.test(fg.appName)
    awayStrikes = selfOrTarget ? 0 : awayStrikes + 1
    if (awayStrikes >= 2) {
      logEvent('interrupt-auto-close', ep.appName, ep.title, '已切离违规窗口')
      closeInterrupt()
    }
  }, OVERLAY_POLL_MS)
}

async function interruptPayload(ep: Episode): Promise<Record<string, unknown>> {
  const settings = getSettings()
  const devMinutes = (Date.now() - ep.startTs) / 60000
  const llm = resolveProvider().ready ? (p: string) => textComplete(p, 'tutor-nudge') : undefined
  const nudge = await buildNudge(devMinutes, ep.appName, llm)
  const payload: Record<string, unknown> = {
    goal: settings.tutor.goal,
    appName: ep.appName,
    title: ep.title,
    devMinutes: Math.round(devMinutes),
    breakMinutes: settings.tutor.breakMinutes,
    soundEnabled: settings.tutor.soundEnabled,
    nudge: nudge.instant
  }
  if (nudge.llm) {
    void nudge.llm.then((line) => {
      if (line && interruptWin && !interruptWin.isDestroyed()) {
        interruptWin.webContents.send('supervision:interrupt', { ...payload, nudge: line })
      }
    })
  }
  return payload
}

// ---------------------------------------------------------------------------
// 面板动作(来自渲染层 IPC)
// ---------------------------------------------------------------------------

export async function submitFeedback(text: string): Promise<string> {
  logEvent('feedback', episode?.appName ?? null, episode?.title ?? null, text.slice(0, 200))
  void saveFeedbackToMemory(text).catch(() => {})
  const ack = '记下了。回来只用 2 分钟——先做最小的那一步。'
  if (interruptWin && !interruptWin.isDestroyed()) {
    interruptWin.webContents.send('supervision:interrupt', { ...(lastPayload ?? {}), nudge: ack, done: true })
    setTimeout(() => {
      closeInterrupt()
      if (episode) episode.startTs = Date.now() // 回来后重新计时
    }, 1800)
  }
  return ack
}

export function takeBreak(minutes?: number): void {
  const mins = minutes || getSettings().tutor.breakMinutes
  breakUntil = Date.now() + mins * 60_000
  logEvent('break', episode?.appName ?? null, episode?.title ?? null, `${mins} 分钟`)
  episode = null
  closeInterrupt()
}

export function stopToday(): void {
  pausedDayKey = todayKey()
  logEvent('stop-today', episode?.appName ?? null, episode?.title ?? null, null)
  episode = null
  closeInterrupt()
}

export function supervisionStatus(): {
  active: boolean
  deviating: boolean
  devMinutes: number
  breakUntil: number | null
  pausedToday: boolean
  overlayOpen: boolean
} {
  return {
    active: !!tickTimer,
    deviating: !!episode,
    devMinutes: episode ? (Date.now() - episode.startTs) / 60000 : 0,
    breakUntil: breakUntil > Date.now() ? breakUntil : null,
    pausedToday: pausedDayKey !== null,
    overlayOpen: !!interruptWin
  }
}

/** 设置页"预览强打断":对当前前台窗口立即演示面板效果。 */
export async function previewInterrupt(): Promise<boolean> {
  const fg = getForegroundInfoSync()
  if (!fg) return false
  const geom = getWindowGeom(fg.hwnd)
  if (!geom) return false
  const ep: Episode = {
    hwnd: fg.hwnd,
    appName: fg.appName,
    title: fg.windowTitle,
    startTs: Date.now() - 185_000, // 演示按"已分心 3 分钟"呈现
    gentleSent: true,
    postponed: true,
    lastInterruptAt: Date.now()
  }
  episode = ep
  lastPayload = await interruptPayload(ep)
  showInterrupt(ep, geom)
  previewUntil = Date.now() + 120_000
  logEvent('interrupt-preview', ep.appName, ep.title, null)
  return true
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function isPaused(): boolean {
  if (!pausedDayKey) return false
  // "今天到此为止":按 Dayflow 天边界(凌晨 4 点)跨天自动恢复
  if (pausedDayKey === todayKey()) return true
  pausedDayKey = null
  return false
}

async function tick(): Promise<void> {
  const settings = getSettings()
  if (!settings.tutor.enabled) return
  if (Date.now() < breakUntil) return
  if (isPaused()) return

  const idleSec = powerMonitor.getSystemIdleTime()
  const fg = getForegroundInfoSync()
  if (!fg) return

  const idle = idleSec > settings.capture.idleThresholdSec
  const verdict: Judge = idle ? 'neutral' : judge(fg)

  if (verdict !== 'non-learning') {
    if (episode && interruptWin && !interruptWin.isDestroyed() && Date.now() > previewUntil) {
      // 已经回到学习/离开 → 面板自动消失
      closeInterrupt()
      logEvent('back-to-study', episode.appName, episode.title, verdict)
    }
    episode = null
    return
  }

  if (!episode || episode.hwnd !== fg.hwnd) {
    episode = {
      hwnd: fg.hwnd,
      appName: fg.appName,
      title: fg.windowTitle,
      startTs: Date.now(),
      gentleSent: false,
      postponed: false,
      lastInterruptAt: 0
    }
    logEvent('deviation-start', fg.appName, fg.windowTitle, null)
  }

  const devSec = (Date.now() - episode.startTs) / 1000

  // 轻提醒:桌面通知,点击 = 延迟一次(计时重置)
  if (!episode.gentleSent && !episode.postponed && devSec >= settings.tutor.gentleSec) {
    episode.gentleSent = true
    try {
      const n = new Notification({
        title: '学习小舟',
        body: `已经分心 ${Math.round(devSec / 60)} 分钟了。回来只用 2 分钟,点击稍后提醒。`
      })
      n.on('click', () => {
        if (episode) {
          episode.postponed = true
          episode.gentleSent = true
          episode.startTs = Date.now() // 延迟一次:重新计时
          logEvent('gentle-postpone', episode.appName, episode.title, null)
        }
      })
      n.show()
      logEvent('gentle', episode.appName, episode.title, null)
    } catch {
      // 通知不可用时直接走强打断
    }
  }

  // 强打断 / 重复
  const due =
    devSec >= settings.tutor.interruptSec &&
    Date.now() - episode.lastInterruptAt >= settings.tutor.repeatSec * 1000
  if (due) {
    const geom = getWindowGeom(fg.hwnd)
    if (geom) {
      episode.lastInterruptAt = Date.now()
      lastPayload = await interruptPayload(episode)
      showInterrupt(episode, geom)
      logEvent('interrupt', episode.appName, episode.title, `分心 ${Math.round(devSec / 60)} 分钟`)
    }
  }
}

export function startSupervision(): void {
  stopSupervision()
  pausedDayKey = null
  tickTimer = setInterval(() => void tick(), TICK_MS)
  console.log('[supervision] started')
}

export function stopSupervision(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  closeInterrupt()
  episode = null
}

export function supervisionSync(): void {
  if (getSettings().tutor.enabled) startSupervision()
  else stopSupervision()
}

export function getInterruptState(): Record<string, unknown> | null {
  return lastPayload
}
