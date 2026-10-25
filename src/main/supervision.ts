import { BrowserWindow, Notification, app, powerMonitor, screen } from 'electron'
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
import {
  buildNudgeFallback,
  getCachedNudge,
  saveFeedbackToMemory,
  updateNudgeFromFeedback
} from './ai/tutor'
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

const TICK_MS = 1000 // "立刻"档要求秒级响应;纯本地 FFI 轮询,零 token
const OVERLAY_POLL_MS = 800

type Judge = 'learning' | 'non-learning' | 'neutral'

interface Episode {
  hwnd: number
  pid: number
  appName: string
  title: string
  startTs: number
  gentleSent: boolean
  postponed: boolean
  lastInterruptAt: number
}

let tickTimer: NodeJS.Timeout | null = null
let ticking = false
let overlayTimer: NodeJS.Timeout | null = null
let episode: Episode | null = null
let breakUntil = 0
let pausedDayKey: string | null = null
let interruptWin: BrowserWindow | null = null
let lastPayload: Record<string, unknown> | null = null
let previewUntil = 0 // 预览期间 tick 不自动关面板
let overlayHwnd = 0 // 面板自身句柄,自识别用(标题判断有竞态)
let calmSince = 0 // 进入平静(学习/中立)的时刻,持续平静才收面板
let lastShowAt = 0 // 上次面板弹出时刻,重弹最小间隔用
const CALM_LEARN_SEC = 8 // 持续学习这么久才算真回学习
const CALM_NEUTRAL_SEC = 30 // 持续中立这么久才重置分心状态
const RESHOW_GAP_MS = 30_000 // 两次弹出的最小间隔(防抖/防闪)

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
  overlayHwnd = 0
}

function showInterrupt(ep: Episode, geom: { left: number; top: number; width: number; height: number; titleBarHeight: number }): void {
  // 让出顶部标题栏:用户随时能点到底下 APP 的最小化/关闭。
  // 几何来自 user32(物理像素),Electron setBounds 用逻辑像素(DIP)——
  // 多屏不同缩放时必须换算,否则高缩放屏上位置/尺寸全部偏 scale 倍。
  const dip = screen.screenToDipRect(null, {
    x: geom.left,
    y: geom.top + geom.titleBarHeight,
    width: geom.width,
    height: Math.max(0, geom.height - geom.titleBarHeight)
  })
  const x = dip.x
  const y = dip.y
  const w = Math.max(360, dip.width)
  const h = Math.max(260, dip.height)
  console.log(`[supervision] interrupt bounds phys=${geom.left},${geom.top}+${geom.titleBarHeight} → dip=${x},${y} ${w}x${h}`)

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
  // 记录面板自身 hwnd:自识别必须用句柄——页面 <title> 在 React 挂载前
  // 会把窗口标题顶成 'Dayflow',标题判断有竞态(曾导致面板自关闪烁)
  try {
    overlayHwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0))
  } catch {
    overlayHwnd = 0
  }
  lastShowAt = Date.now()

  // 面板与违规窗口绑定:违规窗口最小化/关闭 → 自动消失;
  // 连续两次观察到"第三方前台"才判切走(目标应用自己的弹窗/右键菜单
  // 按 pid 归为同一方,不算切走)
  const targetHwnd = ep.hwnd
  const targetPid = ep.pid
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
    const selfOrTarget =
      fg.hwnd === targetHwnd || fg.hwnd === overlayHwnd || fg.pid === targetPid
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
  // 打断瞬间零 LLM:直接显示反思/反馈时刻预备好的常驻督促语,缺失才用兜底句
  const nudge = getCachedNudge() || buildNudgeFallback(devMinutes, ep.appName)
  return {
    goal: settings.tutor.goal,
    appName: ep.appName,
    title: ep.title,
    devMinutes: Math.round(devMinutes),
    breakMinutes: settings.tutor.breakMinutes,
    soundEnabled: settings.tutor.soundEnabled,
    nudge
  }
}

// ---------------------------------------------------------------------------
// 面板动作(来自渲染层 IPC)
// ---------------------------------------------------------------------------

const ACK_FALLBACK = '记下了。回来只用 2 分钟——先做最小的那一步。'

function pushToPanel(nudge: string, closeMs: number | null): void {
  lastPayload = { ...(lastPayload ?? {}), nudge, done: true }
  if (interruptWin && !interruptWin.isDestroyed()) {
    interruptWin.webContents.send('supervision:interrupt', lastPayload)
  }
  if (closeMs !== null) {
    setTimeout(() => {
      closeInterrupt()
      if (episode) episode.startTs = Date.now() // 回来后重新计时
    }, closeMs)
  }
}

export async function submitFeedback(text: string): Promise<string> {
  logEvent('feedback', episode?.appName ?? null, episode?.title ?? null, text.slice(0, 200))
  void saveFeedbackToMemory(text).catch(() => {})
  // 先给即时回执,再让 LLM 按反馈重写"下次说的引导"并更新面板展示——
  // 更新结果常驻,下次打断弹出时直接显示,不再单独等 LLM。
  pushToPanel('记下了,让小舟想一想该怎么陪你回来…', null)
  const llm = resolveProvider().ready ? (p: string) => textComplete(p, 'tutor-feedback') : undefined
  if (llm) {
    void updateNudgeFromFeedback(text, llm)
      .then((nudge) => pushToPanel(nudge ?? ACK_FALLBACK, 5000))
      .catch(() => pushToPanel(ACK_FALLBACK, 1800))
  } else {
    pushToPanel(ACK_FALLBACK, 1800)
  }
  return ACK_FALLBACK
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

/**
 * 设置页"预览强打断":对当前前台窗口立即演示面板效果。
 * strict=true 时走真实模式判定(不设预览保护)——回归测试用:
 * 验证面板不会被 tick 的平静判定误关。
 */
export async function previewInterrupt(strict = false): Promise<boolean> {
  const fg = getForegroundInfoSync()
  if (!fg) return false
  const geom = getWindowGeom(fg.hwnd)
  if (!geom) return false
  const ep: Episode = {
    hwnd: fg.hwnd,
    pid: fg.pid,
    appName: fg.appName,
    title: fg.windowTitle,
    startTs: Date.now() - 185_000, // 演示按"已分心 3 分钟"呈现
    gentleSent: true,
    postponed: true,
    lastInterruptAt: Date.now()
  }
  episode = ep
  calmSince = 0
  lastPayload = await interruptPayload(ep)
  showInterrupt(ep, geom)
  previewUntil = strict ? 0 : Date.now() + 120_000
  logEvent('interrupt-preview', ep.appName, ep.title, strict ? 'strict' : null)
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
  if (ticking) return // 串行化:防重叠 tick 抢跑打断逻辑
  ticking = true
  try {
    await tickInner()
  } finally {
    ticking = false
  }
}

async function tickInner(): Promise<void> {
  const settings = getSettings()
  if (!settings.tutor.enabled) return
  if (Date.now() < breakUntil) return
  if (isPaused()) return

  const idleSec = powerMonitor.getSystemIdleTime()
  const fg = getForegroundInfoSync()
  if (!fg) return
  // 面板自身在前台绝不改状态(句柄精确识别;标题判断曾因页面 <title>
  // 竞态把面板误判成"已回学习",造成自关→重弹闪烁)
  if (overlayHwnd && fg.hwnd === overlayHwnd) return

  const idle = idleSec > settings.capture.idleThresholdSec
  const verdict: Judge = idle ? 'neutral' : judge(fg)

  if (verdict !== 'non-learning') {
    // 平静确认:视频/浏览器标题变化会让分类瞬时翻转,抖动不关面板,
    // 持续平静(学习 8s / 中立 30s)才收——这是防闪的核心。
    if (!calmSince) calmSince = Date.now()
    const calmSec = (Date.now() - calmSince) / 1000
    const learnDone = verdict === 'learning' && calmSec >= CALM_LEARN_SEC
    const neutralDone = calmSec >= CALM_NEUTRAL_SEC
    if (learnDone || neutralDone) {
      if (episode && interruptWin && !interruptWin.isDestroyed() && Date.now() > previewUntil) {
        closeInterrupt()
        logEvent('back-to-study', episode.appName, episode.title, `${verdict} ${Math.round(calmSec)}s`)
      }
      episode = null
    }
    return
  }
  calmSince = 0

  if (!episode || episode.hwnd !== fg.hwnd) {
    episode = {
      hwnd: fg.hwnd,
      pid: fg.pid,
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

  // 轻提醒:桌面通知,点击 = 延迟一次(计时重置)。
  // 仅当轻提醒时间严格早于强打断时才有意义;两者相同(含都为"立刻")= 只做强打断。
  const gentleEnabled = settings.tutor.gentleSec < settings.tutor.interruptSec
  if (gentleEnabled && !episode.gentleSent && !episode.postponed && devSec >= settings.tutor.gentleSec) {
    episode.gentleSent = true
    try {
      const devLabel = devSec < 60 ? `${Math.max(1, Math.round(devSec))} 秒` : `${Math.round(devSec / 60)} 分钟`
      const n = new Notification({
        title: '学习小舟',
        body: `已经分心 ${devLabel}了。回来只用 2 分钟,点击稍后提醒。`
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

  // 强打断 / 重复:面板已开时只移位/刷新内容(同一次打断的延续,立即跟随
  // 新违规窗口);面板已关时才重新弹出,且受重复间隔 + 两次弹出最小间隔
  // 双重门控(防抖防闪)。
  const panelOpen = !!interruptWin && !interruptWin.isDestroyed()
  const repeatDue =
    Date.now() - episode.lastInterruptAt >= Math.max(60, settings.tutor.repeatSec) * 1000
  const gapDue = Date.now() - lastShowAt >= RESHOW_GAP_MS
  const due =
    devSec >= settings.tutor.interruptSec &&
    (panelOpen ? episode.lastInterruptAt === 0 || repeatDue : repeatDue && gapDue)
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
