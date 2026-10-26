/**
 * 会话开始询问窗（#/session）：AFK 后回到电脑时弹出"什么时候开始学习?"。
 * 420×300 无边框透明置顶、光标显示器居中、单实例复用（语义同 reminder-window）。
 */
import { BrowserWindow, screen } from 'electron'
import path from 'path'

const W = 420
const H = 300

let win: BrowserWindow | null = null

export function isSessionPromptWindowOpen(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible()
}

export function closeSessionPromptWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}

export function showSessionPromptWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: true,
    resizable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  })
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  win.setBounds({
    x: x + Math.round((width - W) / 2),
    y: y + Math.round((height - H) / 2),
    width: W,
    height: H,
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}#/session`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/session' })
  }
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  win.on('closed', () => {
    win = null
  })
}
