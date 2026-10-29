import { Tray, Menu, nativeImage, app } from 'electron'
import { getSettings, saveSettings } from './settings'
import { restartCapture } from './capture'
import { getRunningTask, startTask, stopTask } from './tasks'
import { isLocked, interceptQuit } from './hardcore'

let tray: Tray | null = null

/** 16x16 template-style dot rendered from a tiny hand-built PNG. */
function trayIcon(active: boolean): Electron.NativeImage {
  const size = 16
  const scale = 4
  const px = new Uint8Array(size * size * 4)
  const r = active ? 82 : 130
  const g = active ? 220 : 134
  const b = active ? 120 : 150
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5
      const dy = y - 7.5
      const inside = dx * dx + dy * dy <= 36
      const i = (y * size + x) * 4
      px[i] = inside ? r : 0
      px[i + 1] = inside ? g : 0
      px[i + 2] = inside ? b : 0
      px[i + 3] = inside ? 255 : 0
    }
  }
  const img = nativeImage.createFromBuffer(Buffer.from(px), { width: size, height: size })
  return img.resize({ width: size * scale, height: size * scale })
}

export function updateTray(onOpen: () => void): void {
  if (!tray) {
    tray = new Tray(trayIcon(true))
    tray.setToolTip('Dayflow')
  }
  const settings = getSettings()
  const paused = settings.capture.pauseUntil !== null && Date.now() < settings.capture.pauseUntil
  const enabled = settings.capture.enabled

  tray.setImage(trayIcon(enabled && !paused))
  tray.setToolTip(paused ? 'Dayflow — 已暂停' : enabled ? 'Dayflow — 记录中' : 'Dayflow — 捕获已关闭')

  const menu = Menu.buildFromTemplate([
    { label: '打开 Dayflow', click: onOpen },
    { type: 'separator' },
    {
      label: getRunningTask() ? '停止手动计时' : '开始手动计时',
      click: () => {
        if (getRunningTask()) {
          stopTask()
        } else {
          startTask('手动计时', null, false)
        }
        updateTray(onOpen)
      }
    },
    {
      label: paused ? '恢复记录' : '暂停记录',
      click: () => {
        if (paused) {
          saveSettings({ capture: { pauseUntil: null } })
        } else {
          saveSettings({ capture: { pauseUntil: Date.now() + 8 * 60 * 60_000 } })
        }
        restartCapture()
        updateTray(onOpen)
      }
    },
    {
      label: '暂停一段时间…',
      submenu: [15, 30, 60, 120, 240].map((min) => ({
        label: min >= 60 ? `${min / 60} 小时` : `${min} 分钟`,
        click: () => {
          saveSettings({ capture: { pauseUntil: Date.now() + min * 60_000 } })
          restartCapture()
          updateTray(onOpen)
        }
      }))
    },
    { type: 'separator' },
    {
      label: isLocked() ? '退出 Dayflow(强力监督中,已禁用)' : '退出 Dayflow',
      click: () => {
        // 强力监督锁定中:退出被拦截并弹剩余时间提示
        const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        if (isLocked()) interceptQuit(e)
        else app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export { trayIcon }
