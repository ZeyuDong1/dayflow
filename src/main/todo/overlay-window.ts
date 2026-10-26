/**
 * Overlay 悬浮窗（语义规格 §5.3/§8）：透明置顶、focusable:false、默认鼠标穿透、
 * bounds 多显示器双保险校验、1s 防抖保存 + 5s 启动宽限、30s 置顶重申。
 */
import { BrowserWindow, screen } from 'electron'
import path from 'path'
import type { OverlayBounds, TodoSettings } from './settings'
import { boundsOnAnyDisplay, type DisplayRect } from '../../shared/overlay-logic'

export { boundsOnAnyDisplay }
export type { DisplayRect }

const DEFAULT_BOUNDS: OverlayBounds = { x: 100, y: 100, width: 350, height: 250 }

let win: BrowserWindow | null = null
let saveTimer: NodeJS.Timeout | null = null
let createdAt = 0
let persistBounds: ((b: OverlayBounds) => void) | null = null
let topmostInterval: NodeJS.Timeout | null = null

export interface DisplayRectLocal {
  x: number
  y: number
  width: number
  height: number
}

export function setBoundsPersister(fn: (b: OverlayBounds) => void): void {
  persistBounds = fn
}

function displayRects(): DisplayRect[] {
  return screen.getAllDisplays().map((d) => d.workArea) as DisplayRect[]
}

function clampBounds(b: OverlayBounds): OverlayBounds {
  return boundsOnAnyDisplay(b, displayRects()) ? b : { ...DEFAULT_BOUNDS }
}

export function getOverlayWindow(): BrowserWindow | null {
  return win
}

export function showOverlayWindow(settings: TodoSettings): void {
  if (win && !win.isDestroyed()) {
    win.show()
    return
  }
  createdAt = Date.now()
  win = new BrowserWindow({
    ...clampBounds(settings.overlay_bounds),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (settings.overlay_settings.mouseIgnore) win.setIgnoreMouseEvents(true, { forward: true })

  win.on('moved', scheduleSave)
  win.on('resized', scheduleSave)
  win.on('closed', () => {
    win = null
    if (saveTimer) clearTimeout(saveTimer)
    if (topmostInterval) clearInterval(topmostInterval)
    topmostInterval = null
  })

  // 绝对置顶维持：事件 + 每 2s 强制提升(用户定:悬浮窗要绝对置顶)。
  // 仅 setAlwaysOnTop 对已在顶带的窗口不改变 z 序——同级的 Spotlight/强打断
  // 面板/其他置顶工具后显示就会压住它;moveTop 把它顶回顶带最上层,
  // focusable:false 所以不会抢走任何焦点(审查重点#5:销毁后不抛错)。
  const reassert = () => {
    if (win && !win.isDestroyed() && win.isVisible()) {
      if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    }
  }
  win.on('show', reassert)
  win.on('focus', reassert)
  win.on('restore', reassert)
  topmostInterval = setInterval(reassert, 2_000)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}#/overlay`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      if (settings.overlay_settings.mouseIgnore) win.setIgnoreMouseEvents(true, { forward: true }) // 就绪后重申穿透
    }
  })
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!win || win.isDestroyed()) return
    if (Date.now() - createdAt < 5000) return // 启动 5s 宽限期（DPI 自适应）
    const b = win.getBounds() as OverlayBounds
    if (!boundsOnAnyDisplay(b, displayRects())) return // 校验不过不保存
    persistBounds?.(b)
  }, 1000)
}

/** 鼠标穿透切换（审查重点#2）。 */
export function setOverlayIgnoreMouse(ignore: boolean): void {
  if (!win || win.isDestroyed()) return
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

/** 重置位置：主显示器 workArea 居中 350×250 并持久化。 */
export function resetOverlayPosition(): void {
  const area = screen.getPrimaryDisplay().workArea
  const b: OverlayBounds = {
    x: area.x + Math.round((area.width - 350) / 2),
    y: area.y + Math.round((area.height - 250) / 2),
    width: 350,
    height: 250,
  }
  if (win && !win.isDestroyed()) win.setBounds(b)
  persistBounds?.(b)
}

export function hideOverlayWindow(): void {
  if (win && !win.isDestroyed()) win.hide()
}
