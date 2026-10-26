/**
 * 任务域装配：domain + server + 广播路由（含硬提醒弹窗）+ IPC 注册。
 * 广播 'todo:event' 发往除 Reminder 窗外的所有窗口；Reminder 窗走专属队列，
 * 软提醒（type==='reminder'）不弹窗。
 */
import { app, BrowserWindow, Dialog, Notification, ipcMain, dialog, shell } from 'electron'
import { db } from '../db'
import { getDbPath } from '../paths'
import { TaskService } from './service'
import { GpuService } from './gpu-service'
import { TimerManager } from './timer-manager'
import { AiReminderService } from './ai-reminder'
import { createTodoServer, type TodoServer } from './server'
import { getTodoSettings, saveTodoSettings, type TodoSettings, type DeepPartial } from './settings'
import { registerTodoIpc, type TodoIpcDeps } from './ipc-registry'
import { showReminderWindow, hideReminderWindow, getReminderWindow, sendToReminder } from './reminder-window'
import {
  setDraftCleanup,
  toggleSpotlight,
  hideSpotlight,
  ensureSpotlightWindow,
  registerSpotlightShortcut,
  unregisterShortcuts,
} from './spotlight-window'
import {
  showOverlayWindow,
  setOverlayIgnoreMouse,
  resetOverlayPosition,
  setBoundsPersister,
} from './overlay-window'
import { cleanupDraftTasks } from '../../shared/execute-command'
import {
  COMPLIANCE_SCHEMA_SQL,
  analyzeSession,
  listAnalyses,
  listSegments,
  getAnalysis,
  type SessionSample,
} from './compliance'
import { createLlmJudge } from './compliance-judge'
import { WandbBridge } from './wandb-bridge'
import { AutoSyncManager } from './mdsync/autoSync'
import { MdSyncService, getEpochtodoPath } from './mdsync/service'
import { parseMdContent } from './mdsync/pure'
import fs from 'fs'

export interface TodoRuntime {
  tasks: TaskService
  gpus: GpuService
  timerManager: TimerManager
  ai: AiReminderService
  server: TodoServer
  start(): Promise<void>
  stop(): Promise<void>
}

export function createTodoRuntime(opts: { port?: number } = {}): TodoRuntime {
  const now = () => Date.now()

  const broadcast = (event: unknown): void => {
    const e = event as { type: string; task?: { type?: string } | null; dismissed?: number }
    if (e.type === 'timer:ended') {
      const t = e.task as { type?: string } | null
      if (t && t.type !== 'reminder') {
        showReminderWindow()
        sendToReminder(e)
      }
    }
    if (e.type === 'ai:reminder-dismissed' && (e.dismissed ?? 0) > 0) {
      hideReminderWindow() // 硬提醒残留弹窗过期作废
    }
    if (e.type === 'fetch-tasks') autoSync.triggerExport() // broadcastFetchTasks = 刷新 + MD 导出
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win === getReminderWindow()) continue // 审查重点#2
      win.webContents.send('todo:event', e)
    }
  }

  const tasks = new TaskService(db)
  const gpus = new GpuService(db)
  const getSettings = () => getTodoSettings(db)
  const timerManager = new TimerManager({
    db,
    tasks,
    gpus,
    getSettings,
    broadcast: broadcast as never,
    now,
    notify: (o) => new Notification({ title: o.title, body: o.body, silent: o.silent ?? true }).show(),
  })
  const ai = new AiReminderService({ db, tasks, broadcast: broadcast as never, now })
  const server = createTodoServer({
    tasks,
    gpus,
    timerManager,
    ai,
    broadcast: broadcast as never,
    now,
    port: opts.port,
  })

  // wandb 桥（语义规格 §9）
  const wandbBridge = new WandbBridge({ tasks, gpus, timerManager, getSettings, broadcast: broadcast as never, now })

  // mdSync（语义规格 §5.5/§5.6）：设置驱动生命周期 + IPC 面
  const mdSyncService = new MdSyncService(db)
  const autoSync = new AutoSyncManager({ db, tasks, broadcast: broadcast as never })

  // MD 实时同步(用户定:实时/双向/立即):所有任务增删改都经由这些服务方法,
  // 包一层让每次变更立即触发 DB→MD 导出(autoSync 内部 300ms 防抖合并突发);
  // mdSync 导入写库不走服务方法,不会形成回环
  for (const m of [
    'createTask',
    'updateTask',
    'deleteTask',
    'deleteAllTasks',
    'appendMemo',
    'setSideFocus',
  ] as const) {
    const orig = (tasks[m] as (...a: unknown[]) => unknown).bind(tasks)
    ;(tasks as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
      const r = orig(...a)
      autoSync.triggerExport()
      return r
    }
  }

  const mdSync = {
    removeTask(filePath: string, taskId: number): Promise<void> {
      return mdSyncService.removeTaskFromMd(filePath, taskId)
    },
    updateTask(filePath: string, taskId: number, newTitle: string): Promise<void> {
      return mdSyncService.updateTaskInMd(filePath, taskId, newTitle)
    },
    moveSubtree(filePath: string, taskId: number): Promise<void> {
      return mdSyncService.moveTaskSubtreeInMd(filePath, taskId)
    },
    currentPath(): string {
      return getSettings().md_sync_folder ? getEpochtodoPath(getSettings().md_sync_folder) : ''
    },
    async selectFolder(): Promise<string | null> {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    async setConfig(enabled: boolean, folder: string): Promise<void> {
      saveTodoSettings(db, { md_sync_enabled: enabled, md_sync_folder: folder })
      if (enabled && folder) autoSync.start(folder)
      else autoSync.stop()
    },
    async getStatus() {
      const st = getSettings()
      return {
        enabled: st.md_sync_enabled,
        folder: st.md_sync_folder,
        filePath: st.md_sync_folder ? getEpochtodoPath(st.md_sync_folder) : '',
        watching: autoSync.isEnabled,
        lastSyncTime: autoSync.lastSyncTime || null,
        error: null,
      }
    },
    async importFile(filePath: string, force: boolean) {
      const r = await mdSyncService.importFromMd(filePath, force)
      broadcast({ type: 'fetch-tasks' })
      return r
    },
    async exportTo(folder: string) {
      await mdSyncService.exportToMd(getEpochtodoPath(folder), tasks.getAllTasks())
    },
    async syncNow(folder: string) {
      const r = await mdSyncService.syncWithMd(getEpochtodoPath(folder), true)
      broadcast({ type: 'fetch-tasks' })
      return r
    },
    async checkFile(folder: string) {
      const fp2 = getEpochtodoPath(folder)
      if (!fs.existsSync(fp2)) return { exists: false, bullets: 0, titles: [] as string[] }
      const rows = parseMdContent(fs.readFileSync(fp2, 'utf-8'))
      return { exists: true, bullets: rows.length, titles: rows.map((r) => r.text) }
    },
    async checkDuplicates(titles: string[]) {
      const set = new Set(tasks.getAllTasks().filter((t) => t.type === 'standard').map((t) => t.title))
      return titles.filter((t) => set.has(t))
    },
    async readFile(filePath: string) {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    },
  }

  const ipcDeps: TodoIpcDeps = {
    tasks,
    gpus,
    timerManager,
    ai,
    getSettings,
    saveSettings: (patch: DeepPartial<TodoSettings>) => {
      const next = saveTodoSettings(db, patch)
      wandbBridge.update() // wandb 设置变更即时重启轮询
      return next
    },
    wandbUpdate: () => wandbBridge.update(),
    setShortcut: (accelerator: string) => {
      const ok = registerSpotlightShortcut(accelerator, toggleSpotlight)
      if (ok) saveTodoSettings(db, { global_shortcut: accelerator })
      return ok
    },
    openExternal: (url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    },
    trainingStatusSnapshot: () => [...timerManager.trainingStatus.values()],
    broadcastAiDismissed: (payload) => broadcast({ type: 'ai:reminder-dismissed', ...payload, force: false, dismissed: 0 }),
    wandbTest: (entity: string, apiKey: string) => wandbBridge.testConnection(entity, apiKey),
    hideReminder: () => hideReminderWindow(),
    hideSpotlight: () => hideSpotlight(),
    setOverlayIgnoreMouse: (ignore: boolean) => setOverlayIgnoreMouse(ignore),
    resetOverlayPosition: () => resetOverlayPosition(),
    focusSessions,
    sessionAnalyses,
    sessionSegments,
    analyzeDay,
    mdSync,
    data: {
      async exportData() {
        const r = await dialog.showSaveDialog({
          defaultPath: `dayflow-backup-${new Date().toISOString().slice(0, 10)}.db`,
          filters: [{ name: 'SQLite', extensions: ['db'] }],
        })
        if (r.canceled || !r.filePath) return null
        db.flush()
        fs.copyFileSync(getDbPath(), r.filePath)
        return { path: r.filePath }
      },
      async importData() {
        const r = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'SQLite', extensions: ['db'] }],
        })
        if (r.canceled || !r.filePaths[0]) return null
        db.flush()
        const target = getDbPath()
        fs.copyFileSync(target, `${target}-backup-${Date.now()}.db`) // 导入前自动备份
        fs.copyFileSync(r.filePaths[0], target)
        return { needsRestart: true }
      },
      clearTodoData() {
        timerManager.cancelAll()
        tasks.deleteAllTasks()
        broadcast({ type: 'fetch-tasks' })
      },
    },
  }
  setDraftCleanup(() => {
    cleanupDraftTasks(tasks.getAllTasks(), (id) => tasks.deleteTask(id))
  })
  setBoundsPersister((b) => {
    saveTodoSettings(db, { overlay_bounds: b })
  })

  // 会话合规分析（功能清单 §九：时间轴窄条 + AI 截图合规比例）
  ;(db as unknown as { exec(sql: string): void }).exec(COMPLIANCE_SCHEMA_SQL)
  const judge = createLlmJudge()
  function focusSessions(day: string) {
    return db
      .all<{ id: number; task_id: number | null; title: string; start_time: string; end_time: string }>(
        "SELECT id, task_id, title, start_time, end_time FROM history WHERE type = 'focus' AND start_time LIKE ? ORDER BY start_time ASC",
        [`${day}%`],
      )
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        title: r.title,
        startTs: Date.parse(r.start_time),
        endTs: Date.parse(r.end_time),
      }))
  }
  function sessionAnalyses(day: string) { return listAnalyses(db, day) }
  function sessionSegments(day: string) { return listSegments(db, day) }
  async function analyzeDay(day: string): Promise<number> {
    let n = 0
    for (const s of focusSessions(day)) {
      if (getAnalysis(db, s.id)) continue
      const samples: SessionSample[] = db
        .all<{ captured_at: number; file_path: string }>(
          'SELECT captured_at, file_path FROM screenshots WHERE is_deleted = 0 AND captured_at >= ? AND captured_at <= ? ORDER BY captured_at ASC',
          [s.startTs, s.endTs],
        )
        .map((r) => ({ capturedAt: r.captured_at, filePath: r.file_path }))
      await analyzeSession(
        { db, judge, now: Date.now },
        { historyId: s.id, taskTitle: s.title, startTs: s.startTs, endTs: s.endTs, samples },
      )
      n++
    }
    return n
  }
  registerTodoIpc(
    {
      handle: (ch, fn) => ipcMain.handle(ch, fn as never),
      on: (ch, fn) => ipcMain.on(ch, fn as never),
    },
    ipcDeps,
  )

  const runtime: TodoRuntime = {
    tasks,
    gpus,
    timerManager,
    ai,
    server,
    async start() {
      timerManager.start()
      ensureSpotlightWindow() // 预建隐藏窗：软提醒等事件从开机起不丢
      if (!registerSpotlightShortcut(getSettings().global_shortcut || 'Alt+Space', toggleSpotlight)) {
        console.error('[todo] Alt+Space 全局热键注册失败（可能被其他软件占用）')
      }
      showOverlayWindow(getSettings())
      {
        const st = getSettings()
        if (st.md_sync_enabled && st.md_sync_folder) autoSync.start(st.md_sync_folder)
      }
      wandbBridge.update()
      try {
        await server.start()
      } catch {
        // 端口占用已在 server 内告警；不阻断应用启动
      }
    },
    async stop() {
      unregisterShortcuts()
      wandbBridge.stop()
      autoSync.stop()
      timerManager.stop()
      await server.stop()
    },
  }
  app.on('before-quit', () => {
    void runtime.stop()
  })
  return runtime
}
