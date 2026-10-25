/**
 * Reminder 硬提醒窗（语义规格 §8）：500×450 无边框透明置顶、居中光标显示器、
 * flashFrame、blur 后 100ms 重申置顶、复用不重建。
 * 窗口未就绪时的事件进队列，did-finish-load 后统一投递（审查重点#1）。
 */
import { BrowserWindow, screen } from 'electron'
import path from 'path'

const W = 500
const H = 450

let win: BrowserWindow | null = null
let ready = false
const queue: unknown[] = []

export function getReminderWindow(): BrowserWindow | null {
  return win
}

export function sendToReminder(event: unknown): void {
  if (win && !win.isDestroyed() && ready) {
    win.webContents.send('todo:event', event)
  } else {
    queue.push(event)
  }
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

export function showReminderWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    win.flashFrame(true)
    return
  }
  ready = false
  queue.length = 0
  win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: true,
    show: false,
    backgroundColor: '#00000000',
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  centerOnCursorDisplay(win)
  win.webContents.on('did-finish-load', () => {
    ready = true
    for (const e of queue.splice(0)) {
      if (win && !win.isDestroyed()) win.webContents.send('todo:event', e)
    }
  })
  win.on('blur', () => {
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
    }, 100)
  })
  win.on('closed', () => {
    win = null
    ready = false
    queue.length = 0
  })
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.flashFrame(true)
    }
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}#/reminder`)
  } else {
    void win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: '/reminder' })
  }
}

export function hideReminderWindow(): void {
  if (win && !win.isDestroyed()) win.hide()
}
