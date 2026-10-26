import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { initPaths } from './paths'
import { db } from './db'
import { getSettings, saveSettings } from './settings'
import {
  startCapture,
  stopCapture,
  restartCapture,
  initPowerMonitoring,
  captureEnabled
} from './capture'
import { startPipeline, stopPipeline, onCardsChanged } from './ai/analyze'
import { startMemoryServer, stopMemoryServer } from './memory/sidecar'
import { bootstrapMemory } from './memory/client'
import { seedKnowledge } from './ai/knowledge'
import { loadNudgeCache } from './ai/tutor'
import { supervisionSync, stopSupervision } from './supervision'
import { startReflectionLoop, stopReflectionLoop } from './ai/reflect-tick'
import { startCleanupSchedule, stopCleanupSchedule } from './cleanup'
import { registerIpc } from './ipc'
import { createTodoRuntime } from './todo/wiring'
import { installAppMenu } from './menu'
import { updateTray, destroyTray } from './tray'
import { startWindowTracking, stopWindowTracking } from './windows-poll'
import { loadAppIcons } from './app-icons'
import { ensureDefaultProjects } from './projects'
import { classifyBacklogApps } from './ai/llm-classify'

// Ensure userData points at .../Dayflow even in dev.
app.setName('Dayflow')

// DAYFLOW_USER_DATA: parallel dev instances get their own data root (db,
// recordings, app-icons.json) and skip the single-instance lock so two can
// run side by side. Settings live in the db, so the data root is the only
// shared-state chokepoint besides the mock-provider port.
const devDataRoot = process.env.DAYFLOW_USER_DATA
if (devDataRoot) app.setPath('userData', devDataRoot)

let mainWindow: BrowserWindow | null = null
let isQuitting = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#faf0e6',
    show: false,
    title: 'Dayflow',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show()
  })
  // Fallback in case ready-to-show never fires (e.g. a load hiccup).
  win.webContents.on('did-finish-load', () => {
    if (!process.argv.includes('--hidden') && !win.isVisible()) win.show()
  })

  win.on('close', (e) => {
    // Closing the window keeps the app running in the tray; Quit goes through
    // the tray menu / before-quit.
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    win.loadURL(devUrl).catch(() => {
      // Preview mode (no dev server running): fall back to the built files.
      void win.loadFile(path.join(__dirname, '../renderer/index.html'))
    })
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

function applyLoginItem(): void {
  app.setLoginItemSettings({
    openAtLogin: getSettings().general.launchAtLogin,
    args: ['--hidden']
  })
}

function showMainWindow(): void {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
}

const gotLock = devDataRoot ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  void app.whenReady().then(async () => {
    initPaths()
    await db.init()

    // Window-less IPC first (login item), then window-scoped handlers.
    ipcMain.handle('app:setLoginItem', (_e, enabled: boolean) => {
      saveSettings({ general: { launchAtLogin: enabled } })
      applyLoginItem()
      return true
    })

    mainWindow = createWindow()
    registerIpc(mainWindow)
    const todoRuntime = createTodoRuntime({ port: process.env.DAYFLOW_TODO_PORT ? Number(process.env.DAYFLOW_TODO_PORT) : undefined })
    void todoRuntime.start()
    installAppMenu(() => mainWindow)

    initPowerMonitoring()
    loadAppIcons()
    ensureDefaultProjects()
    onCardsChanged(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('timeline:changed', { at: Date.now() })
      }
    })

    if (captureEnabled()) startCapture()
    startWindowTracking()
    startPipeline()
    startCleanupSchedule()
    applyLoginItem()
    updateTray(showMainWindow)

    // 记忆侧车(ai-memory) + 知识库种子 + 导师反思循环 + 学习监督。
    void startMemoryServer().then(async (ok) => {
      if (!ok) return
      await bootstrapMemory(getSettings().tutor.goal)
      await seedKnowledge()
      await loadNudgeCache()
      startReflectionLoop()
    })
    supervisionSync()

    // Classify never-seen apps (including a backlog from before setup).
    classifyBacklogApps()

    // Refresh tray state periodically so pause expiry is reflected.
    setInterval(() => {
      updateTray(showMainWindow)
      const settings = getSettings()
      if (settings.capture.pauseUntil !== null && Date.now() >= settings.capture.pauseUntil) {
        saveSettings({ capture: { pauseUntil: null } })
        restartCapture()
      }
    }, 30_000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
      else showMainWindow()
    })

    // Self-test hook: DAYFLOW_SCREENSHOT=<path> captures the window and exits.
    // DAYFLOW_SHOT_NAV=<index> optionally clicks a sidebar nav item first (4=设置).
    const shotPath = process.env.DAYFLOW_SCREENSHOT
    if (shotPath) {
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        // 隐藏窗口里遮挡检测会彻底停帧（DOM 变更不被绘制，capturePage 抓旧帧），
        // 自测前先显示窗口恢复产帧。
        if (!mainWindow.isVisible()) mainWindow.show()
        const navIdx = Number(process.env.DAYFLOW_SHOT_NAV ?? '4')
        const extraJs = process.env.DAYFLOW_SHOT_JS ?? ''
        const clickNav = mainWindow.webContents
          .executeJavaScript(
            `(() => { const items = document.querySelectorAll('.nav-item'); if (items[${navIdx}]) items[${navIdx}].click(); ${
              extraJs ? 'setTimeout(() => { try { ' + extraJs + ' } catch (e) { document.title = "JSERR:" + e.message } }, 2500); ' : ''
            }return "nav-ok" })()`,
            true
          )
          .then((r: unknown) => console.log('[shot-js]', JSON.stringify(r)))
          .catch((e: unknown) => console.log('[shot-js] ERR', e))
        void clickNav
          .then(() => new Promise((resolve) => setTimeout(resolve, extraJs ? Number(process.env.DAYFLOW_SHOT_WAIT ?? '25000') : 1500)))
          .then(() => {
            console.log('[shot-title]', mainWindow?.getTitle())
            return undefined
          })
          // 隐藏窗口里合成器会停帧，DOM 变更不被绘制；强制重绘后再截，
          // 否则 capturePage 抓到的是点击前的陈旧帧。DAYFLOW_SHOT_WIN=interrupt
          // 时改为截取强打断面板（按 #/interrupt 定位）。
          .then((): Promise<BrowserWindow | null> => {
            const target =
              process.env.DAYFLOW_SHOT_WIN === 'interrupt'
                ? (BrowserWindow.getAllWindows().find(
                    (w) => !w.isDestroyed() && w.webContents.getURL().includes('#/interrupt')
                  ) ?? mainWindow)
                : process.env.DAYFLOW_SHOT_WIN === 'overlay'
                  ? (BrowserWindow.getAllWindows().find(
                      (w) => !w.isDestroyed() && w.webContents.getURL().includes('#/overlay')
                    ) ?? mainWindow)
                  : mainWindow
            if (!target || target.isDestroyed()) return Promise.resolve(null)
            const wins = BrowserWindow.getAllWindows().map(
              (w) => `${w.isDestroyed() ? 'DESTROYED' : w.webContents.getURL()} | ${w.getTitle()}`
            )
            console.log('[shot-wins]', JSON.stringify(wins))
            target.webContents.invalidate()
            return new Promise((resolve) => setTimeout(() => resolve(target), 500))
          })
          .then((target) => (target && !target.isDestroyed() ? target.webContents.capturePage() : null))
          .then((img) => {
            if (img) fs.writeFileSync(shotPath, img.toPNG())
            console.log(`[screenshot] saved ${shotPath}`)
            app.quit()
          })
      }, 5000)
    }
  })
}

app.on('before-quit', () => {
  isQuitting = true
  stopCapture()
  stopWindowTracking()
  stopPipeline()
  stopReflectionLoop()
  stopMemoryServer()
  stopSupervision()
  stopCleanupSchedule()
  db.flush()
})

app.on('will-quit', () => {
  db.flush()
  db.close()
  destroyTray()
})

app.on('window-all-closed', () => {
  // Keep running in the tray.
})
