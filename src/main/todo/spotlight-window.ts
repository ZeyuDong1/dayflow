/**
 * Spotlight 窗（语义规格 §8）：800×600 无边框透明置顶、显示居中到光标显示器、
 * Alt+Space 全局热键切换显隐（可改键）、隐藏时清理空白标题草稿。
 */
import { BrowserWindow, globalShortcut, screen } from 'electron'
import path from 'path'

const W = 800
const H = 600

let win: BrowserWindow | null = null
let draftCleanup: (() => void) | null = null

export function setDraftCleanup(fn: () => void): void {
  draftCleanup = fn
}

function centerOnCursorDisplay(w: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  w.setBounds({
    x: x + Math.round((width - W) / 2),
    y: y + Math.round((height - H) / 2),
    width: W,
    height: H,
  })
}

export function showSpotlight(): void {
  if (win && !win.isDestroyed()) {
    centerOnCursorDisplay(win)
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  centerOnCursorDisplay(win)
  win.on('closed', () => {
    win = null
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}#/spotlight`)
  } else {
    void win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: '/spotlight' })
  }
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.show()
  })
}

export function hideSpotlight(): void {
  if (win && !win.isDestroyed()) win.hide()
  draftCleanup?.() // 空白标题草稿清理（审查重点#5：由纯函数保证范围）
}

export function toggleSpotlight(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideSpotlight()
  else showSpotlight()
}

/** 注册/改键全局热键（失败返回 false 仅记日志；改键先 unregisterAll 再注册）。 */
export function registerSpotlightShortcut(accelerator: string, onToggle: () => void): boolean {
  globalShortcut.unregisterAll()
  try {
    return globalShortcut.register(accelerator, onToggle)
  } catch {
    console.error(`[todo] 全局热键注册失败: ${accelerator}`)
    return false
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
