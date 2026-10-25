/**
 * 任务域装配：domain + server + 广播路由（含硬提醒弹窗）+ IPC 注册。
 * 广播 'todo:event' 发往除 Reminder 窗外的所有窗口；Reminder 窗走专属队列，
 * 软提醒（type==='reminder'）不弹窗。
 */
import { app, BrowserWindow, Notification, ipcMain } from 'electron'
import { db } from '../db'
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
  getAnalysis,
  type SessionSample,
} from './compliance'
import { createLlmJudge } from './compliance-judge'

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

  const ipcDeps: TodoIpcDeps = {
    tasks,
    gpus,
    timerManager,
    ai,
    getSettings,
    saveSettings: (patch: DeepPartial<TodoSettings>) => saveTodoSettings(db, patch),
    hideReminder: () => hideReminderWindow(),
    hideSpotlight: () => hideSpotlight(),
    setOverlayIgnoreMouse: (ignore: boolean) => setOverlayIgnoreMouse(ignore),
    resetOverlayPosition: () => resetOverlayPosition(),
    focusSessions,
    sessionAnalyses,
    analyzeDay,
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
      registerSpotlightShortcut('Alt+Space', toggleSpotlight) // 失败仅记日志
      showOverlayWindow(getSettings())
      try {
        await server.start()
      } catch {
        // 端口占用已在 server 内告警；不阻断应用启动
      }
    },
    async stop() {
      unregisterShortcuts()
      timerManager.stop()
      await server.stop()
    },
  }
  app.on('before-quit', () => {
    void runtime.stop()
  })
  return runtime
}
