import { BrowserWindow, Notification, app, powerMonitor, screen } from 'electron'
import path from 'path'
import { getSettings } from './settings'
import { todayKey } from './paths'
import { db } from './db'
import { classifyActivity, classifyActivityDetail, isBrowserApp, listProjects } from './projects'
import { matchAllowance } from './allowances'
import {
  closeTabInWindow,
  closeWindow,
  getForegroundInfoSync,
  getWindowGeom,
  getWindowTitleByHwnd,
  isBrowserWindow,
  isWindowUsable,
  minimizeWindow,
  type ForegroundInfo,
  type WindowGeom
} from './foreground'
import { lookupPageUrl } from './browser-history'
import {
  buildNudgeFallback,
  getCachedNudge,
  saveFeedbackToMemory,
  updateNudgeFromFeedback
} from './ai/tutor'
import { textComplete, resolveProvider } from './ai/providers'
import {
  closeSessionPromptWindow,
  isSessionPromptWindowOpen,
  showSessionPromptWindow,
} from './session-prompt-window'

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

// ---- 番茄攒息(用户定:连续学习按比例攒休息;面板支取;提前回学习回存) ----
let breakBalanceMs = 0 // 已攒未用的休息余额
let lastLearnTickAt = 0 // 连续学习的上一个 tick 时刻(中断即清零,体现"连续")
let earnedBreakActive = false // 当前正处于番茄支取的休息中
let earnedCdUntil = 0 // 番茄冷却截止(支取休息自然结束后进入,期内不可再次支取)
let sessionAway = false // 当前处于 AFK 状态
let sessionSnoozeUntil = 0 // 跳过后下次重复询问的时刻
let sessionGateUntil = 0 // "N 分钟后开始"的宽限截止,期内不打断
let initialSessionPromptFired = false // 开场第一次询问是否已弹过(每次 app 运行一次)
// 切回"最近弹过面板的违规窗口"的记忆时长:面板因切走自动消失只是给别的
// 窗口让路,不代表赦免——记忆期内回到同一违规窗口立即重新覆盖,不留逃逸口。
const RETURN_MEMORY_MS = 10 * 60_000

let panelTargetHwnd = 0 // 面板当前覆盖的目标窗口(最小化/关闭出口用)
let panelTargetApp = '' // 目标应用名(日志用)
const lastPanelByHwnd = new Map<number, number>() // hwnd → 上次面板弹出时刻

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

function judge(fg: ForegroundInfo): Judge {
  if (fg.windowTitle === '学习监督') return 'neutral' // 打断面板自己
  if (/dayflow/i.test(fg.appName)) return 'neutral' // Dayflow 自身(设置/查看时间线)
  return judgeInfo(fg.appName, fg.windowTitle)
}

/** 按应用+标题判定(遮蔽轮询对被遮窗口当前内容复判用)。 */
function judgeInfo(appName: string, title: string): Judge {
  const settings = getSettings()
  if (isPrivate(appName, title)) return 'neutral'
  if (matchAllowance(appName, title)) return 'learning'
  const projectId = classifyActivity(appName, title)
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
  panelTargetHwnd = 0
  panelTargetApp = ''
}

/** 面板出口:最小化被覆盖的应用(等价标题栏最小化)。之后目标不可用 → 面板自动消失。 */
export function minimizeInterruptTarget(): boolean {
  if (!panelTargetHwnd) return false
  const ok = minimizeWindow(panelTargetHwnd)
  if (ok) logEvent('interrupt-target-minimize', panelTargetApp, null, null)
  return ok
}

/** 面板出口:关闭被覆盖的应用。浏览器特殊化(用户定):只关当前网页(Ctrl+W),
 * 不关整只浏览器;其余应用保持 WM_CLOSE 温和关闭。 */
export function closeInterruptTarget(): boolean {
  if (!panelTargetHwnd) return false
  const browser = isBrowserWindow(panelTargetHwnd)
  const ok = browser ? closeTabInWindow(panelTargetHwnd) : closeWindow(panelTargetHwnd)
  if (ok) logEvent('interrupt-target-close', panelTargetApp, null, browser ? '浏览器→Ctrl+W 关网页' : 'WM_CLOSE')
  return ok
}

// ---------------------------------------------------------------------------
// 显示器物理↔DIP 映射:探针标定(不依赖有歧义的换算 API)
// ---------------------------------------------------------------------------

interface DisplayCal {
  dip: { x: number; y: number; width: number; height: number } // DIP 矩形
  physOrigin: { x: number; y: number } // 该 DIP 原点实测的物理原点
  scale: number
}

let calCache: DisplayCal[] | null = null
let calListenersBound = false

function bindCalInvalidation(): void {
  if (calListenersBound) return
  calListenersBound = true
  const invalidate = (): void => {
    calCache = null
  }
  screen.on('display-metrics-changed', invalidate)
  screen.on('display-added', invalidate)
  screen.on('display-removed', invalidate)
}

/**
 * 用隐形探针窗口标定每台显示器的 DIP→物理 映射:
 * 在 DIP 原点放一个 8x8 无边框窗口,GetWindowRect 读回物理位置——
 * 直接对 Electron 的窗口摆放做闭环测量,任何换算 API 的语义歧义都被绕开。
 */
function calibrateDisplays(): DisplayCal[] {
  bindCalInvalidation()
  if (calCache) return calCache
  const cals: DisplayCal[] = []
  for (const d of screen.getAllDisplays()) {
    let physOrigin = {
      x: Math.round(d.bounds.x * d.scaleFactor),
      y: Math.round(d.bounds.y * d.scaleFactor)
    }
    try {
      const probe = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: 8,
        height: 8,
        frame: false,
        show: false,
        skipTaskbar: true,
        focusable: false
      })
      const g = getWindowGeom(Number(probe.getNativeWindowHandle().readBigUInt64LE(0)))
      // 探针的客户区原点 = setBounds DIP 原点的真实物理映射
      // (外框含隐形边框,实测偏 8px×缩放,必须用客户区)
      if (g) physOrigin = { x: g.clientX, y: g.clientY }
      probe.destroy()
    } catch {
      // 标定失败退回估算值
    }
    cals.push({ dip: d.bounds, physOrigin, scale: d.scaleFactor })
  }
  calCache = cals
  return cals
}

/**
 * 物理像素 → 逻辑像素,逐显示器精确换算:
 *   dip = 显示器DIP原点 + (物理 − 该显示器实测物理原点) / 缩放
 * screenToDipRect(null, …) 按主屏 DPI 统一缩放、nativeOrigin 并非物理
 * 原点——两者在副屏不同缩放时都会偏(一台准一台不准的根因)。
 */
function physToDip(phys: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  const cals = calibrateDisplays()
  const cx = phys.x + phys.width / 2
  const cy = phys.y + phys.height / 2
  const cal =
    cals.find(
      (c) =>
        cx >= c.physOrigin.x &&
        cx < c.physOrigin.x + Math.round(c.dip.width * c.scale) &&
        cy >= c.physOrigin.y &&
        cy < c.physOrigin.y + Math.round(c.dip.height * c.scale)
    ) ?? cals[0]
  return {
    x: cal.dip.x + (phys.x - cal.physOrigin.x) / cal.scale,
    y: cal.dip.y + (phys.y - cal.physOrigin.y) / cal.scale,
    width: phys.width / cal.scale,
    height: phys.height / cal.scale
  }
}

/**
 * 覆盖矩形(DIP):DWM 可见框横向全盖(可见边框也算应用的一部分),
 * 顶部从客户区顶开始(让出标题栏),底部到可见框底。
 * 可见框用 DWM 扩展边框——GetWindowRect 的外框含 ~8px×DPI 隐形边框,
 * 高分屏上那道缝隙就是"没对准"的来源之一。
 */
function coverageDipFrom(geom: WindowGeom): { x: number; y: number; width: number; height: number } {
  const phys = {
    x: geom.frameLeft,
    y: geom.clientY,
    width: Math.max(1, geom.frameRight - geom.frameLeft),
    height: Math.max(1, geom.frameBottom - geom.clientY)
  }
  const dip = physToDip(phys)
  return {
    x: Math.round(dip.x),
    y: Math.round(dip.y),
    width: Math.max(360, Math.round(dip.width)),
    height: Math.max(260, Math.round(dip.height))
  }
}

function showInterrupt(ep: Episode, geom: WindowGeom): void {
  const bounds = coverageDipFrom(geom)
  const naive = screen.screenToDipRect(
    null,
    {
      x: geom.frameLeft,
      y: geom.clientY,
      width: Math.max(1, geom.frameRight - geom.frameLeft),
      height: Math.max(1, geom.frameBottom - geom.clientY)
    }
  ) // 对照:主屏统一缩放(副屏会偏)
  const { x, y, width: w, height: h } = bounds
  const topo = calibrateDisplays()
    .map((c) => `${c.scale}@phys${c.physOrigin.x},${c.physOrigin.y}→dip(${c.dip.x},${c.dip.y})`)
    .join(' | ')
  console.log(
    `[supervision] bounds frame=${geom.frameLeft},${geom.frameTop}..${geom.frameRight},${geom.frameBottom} clientTop=${geom.clientY} → per-monitor=${x},${y} ${w}x${h} naive=${naive.x},${naive.y} ${naive.width}x${naive.height} displays=[${topo}]`
  )

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
  panelTargetHwnd = ep.hwnd
  panelTargetApp = ep.appName
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
  // 按 pid 归为同一方,不算切走)。
  // 同时面板实时跟随目标窗口的移动/缩放(拖不走),并纠正任何边界漂移
  // (如跨屏 DPI 变更时系统对面板矩形的改写)。
  const targetHwnd = ep.hwnd
  const targetPid = ep.pid
  let awayStrikes = 0
  // 实时显示被遮窗口的 title/网址:点"关闭网页"后面板还盖着,不显示的话
  // 用户不知道现在底下是哪个页面(浏览器同窗口换标签 hwnd 不变,只能轮询标题)
  let liveTargetTitle = ''
  let liveTargetUrl: string | null = null
  let learningStrikes = 0 // 当前内容连续判为学习的次数
  overlayTimer = setInterval(() => {
    if (!interruptWin || interruptWin.isDestroyed()) return
    if (!isWindowUsable(targetHwnd)) {
      logEvent('interrupt-auto-close', ep.appName, ep.title, '违规窗口已最小化/关闭')
      closeInterrupt()
      return
    }
    const liveTitle = getWindowTitleByHwnd(targetHwnd)
    if (liveTitle && liveTitle !== liveTargetTitle) {
      liveTargetTitle = liveTitle
      liveTargetUrl = null
      const pushLive = (): void => {
        if (!interruptWin || interruptWin.isDestroyed()) return
        lastPayload = { ...(lastPayload ?? {}), targetTitle: liveTargetTitle, targetUrl: liveTargetUrl }
        interruptWin.webContents.send('supervision:interrupt', lastPayload)
      }
      pushLive()
      if (isBrowserApp(ep.appName)) {
        void lookupPageUrl(ep.appName, liveTitle).then((url) => {
          // 查询期间标题又变了就丢弃这轮结果(下一轮会用新标题重查)
          if (liveTargetTitle !== liveTitle) return
          liveTargetUrl = url
          pushLive()
        })
      }
    }
    // 跟随目标窗口 + 纠偏:目标几何变了(拖动/缩放/最大化)→ 面板跟上;
    // 目标没变而面板边界偏离意图(如 DPI 变更被系统改写)→ 纠正回来
    const g = getWindowGeom(targetHwnd)
    if (g) {
      const want = coverageDipFrom(g)
      const cur = interruptWin.getBounds()
      const drifted =
        Math.abs(cur.x - want.x) > 2 ||
        Math.abs(cur.y - want.y) > 2 ||
        Math.abs(cur.width - want.width) > 2 ||
        Math.abs(cur.height - want.height) > 2
      if (drifted) {
        const moved = Math.abs(cur.x - want.x) > 2 || Math.abs(cur.y - want.y) > 2
        interruptWin.setBounds(want)
        if (moved) logEvent('interrupt-follow', ep.appName, ep.title, `→ ${want.x},${want.y} ${want.width}x${want.height}`)
      }
    }
    // 预览期:只演示"最小化/关闭即消失",切走不关(方便慢慢看效果)
    if (Date.now() < previewUntil) return
    // 违规解除自查:被遮窗口换了内容(关网页/换标签,hwnd 不变)后,当前标题
    // 若已判为学习(白名单/豁免/效率分),连续两次确认即跟随关闭。
    // 之后若再回到违规内容,常规监督会重新升级打断(切回 10 分钟内立即重覆盖)。
    if (liveTargetTitle && judgeInfo(ep.appName, liveTargetTitle) === 'learning') {
      learningStrikes += 1
      if (learningStrikes >= 2) {
        logEvent('interrupt-auto-close', ep.appName, liveTargetTitle, '当前内容已回到学习范围')
        closeInterrupt()
        return
      }
    } else {
      learningStrikes = 0
    }
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
  // 判定依据:命中了哪个分类/规则才遮蔽(用户要求面板可见)
  const detail = classifyActivityDetail(ep.appName, ep.title)
  const proj = detail ? listProjects().find((p) => p.id === detail.projectId) ?? null : null
  const match =
    detail && proj
      ? {
          projectId: detail.projectId,
          project: proj.title,
          score: proj.productivityScore,
          source: detail.source,
          matched: detail.matched,
          whitelist:
            settings.tutor.allowedProjectIds.length > 0 &&
            !settings.tutor.allowedProjectIds.includes(detail.projectId)
        }
      : null
  return {
    goal: settings.tutor.goal,
    appName: ep.appName,
    title: ep.title,
    targetTitle: ep.title,
    targetUrl: null as string | null,
    devMinutes: Math.round(devMinutes),
    breakMinutes: settings.tutor.breakMinutes,
    allowBreak: settings.tutor.allowBreak,
    allowStopToday: settings.tutor.allowStopToday,
    earnedBreakMinutes: Math.floor(breakBalanceMs / 60000),
    earnedCdRemainingMinutes: Math.max(0, Math.ceil((earnedCdUntil - Date.now()) / 60000)),
    targetIsBrowser: isBrowserWindow(ep.hwnd),
    match,
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
  // 设置不允许"暂停遮蔽几分钟"时直接拒绝（面板按钮也不会渲染,此处兜底）
  if (!getSettings().tutor.allowBreak) {
    logEvent('break-denied', episode?.appName ?? null, episode?.title ?? null, 'allowBreak=false')
    return
  }
  const mins = minutes || getSettings().tutor.breakMinutes
  breakUntil = Date.now() + mins * 60_000
  logEvent('break', episode?.appName ?? null, episode?.title ?? null, `${mins} 分钟`)
  episode = null
  closeInterrupt()
}

/** 番茄余额支取:强打断面板上选择休息时长(秒,须 ≤ 余额且 ≥ 1 分钟)。
 * 休息期内零打扰;提前回学习时没用完的余额由 tick 回存。 */
export function takeEarnedBreak(seconds: number): boolean {
  const want = Math.floor(seconds)
  const maxSec = Math.floor(breakBalanceMs / 1000)
  if (want < 60 || want > maxSec) {
    logEvent(
      'earned-break-denied',
      episode?.appName ?? null,
      episode?.title ?? null,
      `请求 ${want}s / 余额 ${maxSec}s`
    )
    return false
  }
  if (Date.now() < earnedCdUntil) {
    logEvent('earned-break-denied', episode?.appName ?? null, episode?.title ?? null, '冷却中')
    return false
  }
  breakBalanceMs -= want * 1000
  breakUntil = Date.now() + want * 1000
  earnedBreakActive = true
  logEvent('earned-break', episode?.appName ?? null, episode?.title ?? null, `${Math.round(want / 60)} 分钟`)
  episode = null
  calmSince = 0
  lastLearnTickAt = 0
  closeInterrupt()
  return true
}

export function stopToday(): void {
  // 设置不允许"今天到此为止"时直接拒绝（面板按钮也不会渲染,此处兜底）
  if (!getSettings().tutor.allowStopToday) {
    logEvent('stop-today-denied', episode?.appName ?? null, episode?.title ?? null, 'allowStopToday=false')
    return
  }
  pausedDayKey = todayKey()
  logEvent('stop-today', episode?.appName ?? null, episode?.title ?? null, null)
  episode = null
  closeInterrupt()
}

/** 会话询问:现在就开始学习(关窗,监督立即生效) */
export function startSessionNow(): void {
  closeSessionPromptWindow()
  sessionSnoozeUntil = 0
  sessionGateUntil = 0
  logEvent('session-start-now', null, null, null)
}

/** 会话询问:N 分钟后开始学习(宽限期内不打断,到期监督自动生效) */
export function startSessionIn(minutes: number): void {
  closeSessionPromptWindow()
  sessionSnoozeUntil = 0
  sessionGateUntil = Date.now() + Math.max(1, minutes) * 60_000
  logEvent('session-start-in', null, null, `${minutes} 分钟`)
}

/** 会话询问:跳过——X 分钟后重复询问(用户可自行设定 X) */
export function snoozeSessionPrompt(): void {
  closeSessionPromptWindow()
  const min = Math.max(1, getSettings().tutor.sessionPromptSnoozeMin)
  sessionSnoozeUntil = Date.now() + min * 60_000
  logEvent('session-snooze', null, null, `${min} 分钟`)
}

export function supervisionStatus(): {
  active: boolean
  deviating: boolean
  devMinutes: number
  breakUntil: number | null
  pausedToday: boolean
  overlayOpen: boolean
  breakBalanceMinutes: number
} {
  return {
    active: !!tickTimer,
    deviating: !!episode,
    devMinutes: episode ? (Date.now() - episode.startTs) / 60000 : 0,
    breakUntil: breakUntil > Date.now() ? breakUntil : null,
    pausedToday: pausedDayKey !== null,
    overlayOpen: !!interruptWin,
    breakBalanceMinutes: Math.floor(breakBalanceMs / 60000)
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
  // "今天到此为止":按天边界(午夜 0 点)跨天自动恢复
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
  if (isPaused()) return

  // 会话开始门控(用户定):AFK 超过 Y 分钟后再次活动=开始使用电脑 → 弹窗询问
  // 何时开始学习;提示窗未决/跳过等待/宽限期内,轻提醒与强遮蔽一律不出
  const sessionIdleSec = powerMonitor.getSystemIdleTime()
  const sessionAfkSec = Math.max(1, settings.tutor.sessionPromptAfkMin) * 60
  if (settings.tutor.sessionPromptEnabled && !isSessionPromptWindowOpen()) {
    if (sessionIdleSec >= sessionAfkSec) {
      sessionAway = true
    } else if (sessionAway) {
      sessionAway = false
      if (Date.now() >= sessionSnoozeUntil) {
        showSessionPromptWindow()
        logEvent('session-prompt', null, null, null)
      }
    }
  }
  if (sessionSnoozeUntil > 0 && Date.now() >= sessionSnoozeUntil) {
    sessionSnoozeUntil = 0
    if (settings.tutor.sessionPromptEnabled) {
      showSessionPromptWindow()
      logEvent('session-prompt', null, null, 're-ask')
    }
  }

  // 番茄支取的休息自然到期 → 进入冷却(用户设定时长);期内面板不可再次支取。
  // 提前回学习回收的不进冷却(人已经回到学习,惩罚无意义)
  if (earnedBreakActive && breakUntil > 0 && Date.now() >= breakUntil) {
    earnedBreakActive = false
    breakUntil = 0
    const cdMin = getSettings().tutor.earnedBreakCooldownMin
    if (cdMin > 0) {
      earnedCdUntil = Date.now() + cdMin * 60_000
      logEvent('earned-break-cd', null, null, `${cdMin} 分钟`)
    }
  }

  // 番茄休息进行中:零打扰(弱提醒/强遮蔽都不出);持续 8s 回学习则把没用完的余额回存
  if (Date.now() < breakUntil) {
    const fgB = getForegroundInfoSync()
    const idleB = fgB ? powerMonitor.getSystemIdleTime() > settings.capture.idleThresholdSec : true
    if (fgB && !idleB && !(overlayHwnd && fgB.hwnd === overlayHwnd) && judge(fgB) === 'learning') {
      if (!calmSince) calmSince = Date.now()
      if ((Date.now() - calmSince) / 1000 >= CALM_LEARN_SEC) {
        const remainMs = breakUntil - Date.now()
        breakUntil = 0
        calmSince = 0
        earnedBreakActive = false // 提前回学习:无冷却
        lastLearnTickAt = Date.now() // 无缝接续攒息
        logEvent(
          'break-reclaim',
          fgB.appName,
          fgB.windowTitle,
          remainMs > 0 ? `回存 ${Math.round(remainMs / 60000)} 分钟` : '已用完'
        )
      }
    } else {
      calmSince = 0
    }
    return
  }

  const idleSec = powerMonitor.getSystemIdleTime()
  const fg = getForegroundInfoSync()
  if (!fg) return
  // 面板自身在前台绝不改状态(句柄精确识别;标题判断曾因页面 <title>
  // 竞态把面板误判成"已回学习",造成自关→重弹闪烁)
  if (overlayHwnd && fg.hwnd === overlayHwnd) return

  const idle = idleSec > settings.capture.idleThresholdSec
  const verdict: Judge = idle ? 'neutral' : judge(fg)

  // 番茄攒息:连续学习每 N 分钟攒 1 分钟(N=breakRatioMinutes,默认 5 = 学25休5)。
  // 判定一离开学习即清零连续标记;单 tick 回填上限 10s,防系统休眠恢复后巨涨。
  if (verdict === 'learning') {
    if (lastLearnTickAt > 0) {
      const delta = Math.min(Date.now() - lastLearnTickAt, 10_000)
      breakBalanceMs += delta / Math.max(1, settings.tutor.breakRatioMinutes)
    }
    lastLearnTickAt = Date.now()
  } else {
    lastLearnTickAt = 0
  }

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

  // 会话门控:询问窗未决 / 跳过等待 / 宽限期 → 不计分心、不产生任何打断
  if (isSessionPromptWindowOpen() || Date.now() < sessionSnoozeUntil || Date.now() < sessionGateUntil) return

  if (!episode || episode.hwnd !== fg.hwnd) {
    // 近期在该窗口弹过面板(RETURN_MEMORY_MS 内)= 热违规:不再走轻提醒阶梯,
    // 专注计时按已到期回填——切回来立刻重新覆盖,而不是再给一轮宽限。
    const recentPanelTs = lastPanelByHwnd.get(fg.hwnd)
    const hot = recentPanelTs != null && Date.now() - recentPanelTs < RETURN_MEMORY_MS
    episode = {
      hwnd: fg.hwnd,
      pid: fg.pid,
      appName: fg.appName,
      title: fg.windowTitle,
      startTs: hot ? Date.now() - (settings.tutor.interruptSec + 5) * 1000 : Date.now(),
      gentleSent: hot,
      postponed: hot,
      lastInterruptAt: 0
    }
    logEvent('deviation-start', fg.appName, fg.windowTitle, hot ? 'hot-return' : null)
  }

  const devSec = (Date.now() - episode.startTs) / 1000

  // 轻提醒:桌面通知,点击 = 延迟一次(计时重置)。
  // 仅当轻提醒时间严格早于强打断时才有意义;两者相同(含都为"立刻")= 只做强打断。
  const gentleEnabled = settings.tutor.gentleSec < settings.tutor.interruptSec
  if (gentleEnabled && !episode.gentleSent && !episode.postponed && devSec >= settings.tutor.gentleSec) {
    episode.gentleSent = true
    try {
      const devLabel = devSec < 60 ? `${Math.max(1, Math.round(devSec))} 秒` : `${Math.round(devSec / 60)} 分钟`
      const postpone = settings.tutor.allowPostpone
      const n = new Notification({
        title: '学习小舟',
        body: postpone
          ? `已经分心 ${devLabel}了。回来只用 2 分钟,点击稍后提醒。`
          : `已经分心 ${devLabel}了。回来只用 2 分钟。`
      })
      if (postpone) {
        n.on('click', () => {
          if (episode) {
            episode.postponed = true
            episode.gentleSent = true
            episode.startTs = Date.now() // 延迟一次:重新计时
            logEvent('gentle-postpone', episode.appName, episode.title, null)
          }
        })
      }
      n.show()
      logEvent('gentle', episode.appName, episode.title, postpone ? null : 'no-postpone')
    } catch {
      // 通知不可用时直接走强打断
    }
  }

  // 强打断 / 重复:面板已开时只移位/刷新内容(同一次打断的延续,立即跟随
  // 新违规窗口);面板已关时才重新弹出,且受重复间隔 + 两次弹出最小间隔
  // 双重门控(防抖防闪)——唯一例外:回到"最近弹过面板的同一窗口"立即覆盖。
  const panelOpen = !!interruptWin && !interruptWin.isDestroyed()
  const repeatDue =
    Date.now() - episode.lastInterruptAt >= Math.max(60, settings.tutor.repeatSec) * 1000
  const gapDue = Date.now() - lastShowAt >= RESHOW_GAP_MS
  const recentPanelTs = lastPanelByHwnd.get(fg.hwnd)
  const returningToPanelled = recentPanelTs != null && Date.now() - recentPanelTs < RETURN_MEMORY_MS
  const due =
    devSec >= settings.tutor.interruptSec &&
    (panelOpen
      ? episode.lastInterruptAt === 0 || repeatDue
      : returningToPanelled || (repeatDue && gapDue))
  if (due) {
    const geom = getWindowGeom(fg.hwnd)
    if (geom) {
      episode.lastInterruptAt = Date.now()
      if (lastPanelByHwnd.size > 64) {
        const cutoff = Date.now() - 3_600_000
        for (const [h, ts] of lastPanelByHwnd) if (ts < cutoff) lastPanelByHwnd.delete(h)
      }
      lastPanelByHwnd.set(episode.hwnd, Date.now())
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
  // 刚打开学习导师 → 直接进入第一次询问阶段(用户定);每次 app 运行只问一次,
  // 之后回到常规节奏:AFK→再活动 才重复询问
  if (!initialSessionPromptFired) {
    initialSessionPromptFired = true
    const st = getSettings()
    if (st.tutor.sessionPromptEnabled) {
      setTimeout(() => {
        const s = getSettings()
        if (!tickTimer || !s.tutor.enabled || !s.tutor.sessionPromptEnabled) return
        if (isSessionPromptWindowOpen()) return
        showSessionPromptWindow()
        logEvent('session-prompt', null, null, 'app-open')
      }, 1500) // 等主窗/托盘就绪,避免开场焦点互抢
    }
  }
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
