/**
 * 任务域 IPC 注册面（语义规格 §10；scheduler/dispatch 域已随模块移除）。
 * 纯注册函数：registry 注入（ipcMain 适配器或测试假件），无 Electron 依赖。
 */
import type { TaskService } from './service'
import type { GpuService } from './gpu-service'
import type { TimerManager } from './timer-manager'
import type { AiReminderService } from './ai-reminder'
import type { TodoSettings, DeepPartial } from './settings'
import type { TaskRow } from '../../shared/todo-types'
import type { ParsedCommand } from '../../shared/commands'
import {
  executeCommand,
  confirmGpuPick,
  type ExecDomainOps,
  type ExecResult,
  type TrainingDraft,
} from '../../shared/execute-command'

export interface IpcRegistry {
  handle(channel: string, fn: (...args: never[]) => unknown): void
  on(channel: string, fn: (...args: never[]) => void): void
}

export interface TodoIpcDeps {
  tasks: TaskService
  gpus: GpuService
  timerManager: TimerManager
  ai: AiReminderService
  getSettings: () => TodoSettings
  saveSettings: (patch: DeepPartial<TodoSettings>) => TodoSettings
  hideReminder?: () => void
  hideSpotlight?: () => void
  setOverlayIgnoreMouse?: (ignore: boolean) => void
  resetOverlayPosition?: () => void
  focusSessions?: (day: string) => { id: number; taskId: number | null; title: string; startTs: number; endTs: number }[]
  sessionAnalyses?: (day: string) => unknown[]
  sessionSegments?: (day: string) => unknown[]
  analyzeDay?: (day: string) => Promise<number>
  wandbUpdate?: () => void
  wandbTest?: (entity: string, apiKey: string) => Promise<{ valid: boolean; projectCount: number; hostname: string; error?: string }>
  openExternal?: (url: string) => void
  setShortcut?: (accelerator: string) => boolean
  trainingStatusSnapshot?: () => unknown[]
  broadcastAiDismissed?: (payload: { id?: string; source?: string; title?: string }) => void
  data?: {
    exportData(): Promise<{ path: string } | null>
    importData(): Promise<{ needsRestart: boolean } | null>
    clearTodoData(): void
  }
  mdSync?: {
    removeTask(filePath: string, taskId: number): Promise<void>
    updateTask(filePath: string, taskId: number, newTitle: string): Promise<void>
    moveSubtree(filePath: string, taskId: number): Promise<void>
    currentPath(): string
    selectFolder(): Promise<string | null>
    setConfig(enabled: boolean, folder: string): Promise<void>
    getStatus(): Promise<{
      enabled: boolean
      folder: string
      filePath: string
      watching: boolean
      lastSyncTime: number | null
      error: string | null
    }>
    importFile(filePath: string, force: boolean): Promise<{ created: number; updated: number; duplicates: string[] }>
    exportTo(folder: string): Promise<void>
    syncNow(folder: string): Promise<{ created: number; updated: number; deleted: number }>
    checkFile(folder: string): Promise<{ exists: boolean; bullets: number; titles: string[] }>
    checkDuplicates(titles: string[]): Promise<string[]>
    readFile(filePath: string): Promise<string>
  }
}

/** timer:start-focus 的副焦点轮换：清目标 side 标志；旧焦点非自身则尝试降级为副（满 2 静默跳过）。 */
export function startFocusWithRotation(deps: TodoIpcDeps, taskId: number): void {
  const current =
    deps.tasks.getAllTasks().find((t) => t.status === 'active' && t.timer_type === 'focus') ??
    deps.tasks.getAllTasks().find((t) => t.status === 'active' && t.type !== 'training') ??
    null
  deps.tasks.updateTask(taskId, { is_side_focus: 0 })
  if (current && current.id !== taskId) {
    deps.tasks.setSideFocus(current.id, true) // 满员返回 false，静默跳过
  }
  deps.timerManager.startFocus(taskId)
}

/** 主进程领域操作适配（executeCommand 的同步后端）。 */
function makeMainDomainOps(deps: TodoIpcDeps): ExecDomainOps {
  return {
    getTasks: () => deps.tasks.getAllTasks(),
    listTaskProjects: () => deps.tasks.listTaskProjects(),
    getGpus: () => deps.gpus.getAllGpus(),
    createTask: (title, o) =>
      deps.tasks.createTask(title, {
        type: o.type as never,
        projectId: o.projectId,
        parentId: o.parentId,
        skipDedup: o.skipDedup,
      }),
    updateTask: (id, updates) => deps.tasks.updateTask(id, updates),
    appendMemo: (id, text) => deps.tasks.appendMemo(id, text),
    startFocus: (id) => startFocusWithRotation(deps, id),
    startWait: (id, seconds) => deps.timerManager.startWait(id, seconds),
    assignTaskToGpu: (taskId, gpuId, minutes) => deps.timerManager.startTraining(taskId, gpuId, minutes * 60),
  }
}

export function registerTodoIpc(reg: IpcRegistry, deps: TodoIpcDeps): void {
  const { tasks, gpus, timerManager, ai } = deps

  // 任务域
  reg.handle('todo:get-tasks', (() => tasks.getAllTasks()) as never)
  reg.handle('todo:create-task', ((_e: never, title: string, opts?: never) => tasks.createTask(title, opts)) as never)
  reg.handle(
    'todo:update-task',
    // EpochToDo 终版顺序(缺了就是用户实测的重命名重复 bug):改名先原地重写
    // 绑定 MD 行并回写新 hash,否则下一次 merge 把新标题当新增行、文件侧同步
    // 再把旧标题复活成新任务;层级变化(parent_id)入库后外科搬移子树,否则文件
    // 侧 merge 会把 parent_id"修复"回文件的旧缩进
    (async (_e: never, id: number, updates: Partial<TaskRow>) => {
      const mdPath = deps.mdSync?.currentPath?.() ?? ''
      const isHierarchyChange = updates.parent_id !== undefined
      if (!isHierarchyChange && typeof updates.title === 'string' && mdPath && deps.mdSync?.updateTask) {
        try {
          await deps.mdSync.updateTask(mdPath, id, updates.title)
        } catch {
          /* best-effort MD update */
        }
      }
      const res = tasks.updateTask(id, updates)
      if (isHierarchyChange && mdPath && deps.mdSync?.moveSubtree) {
        try {
          await deps.mdSync.moveSubtree(mdPath, id)
        } catch {
          /* best-effort MD move */
        }
      }
      return res
    }) as never,
  )
  reg.handle('todo:set-side-focus', ((_e: never, id: number, enabled: boolean) => tasks.setSideFocus(id, enabled)) as never)
  reg.handle(
    'todo:delete-task',
    // 先删 MD 行再删库(EpochToDo 终版顺序):任务行带着 md_line_hash,删库后就
    // 无法定位 MD 里的子弹;残留行会被 mdSync 导入侧当真源立刻重建任务(用户实测"删了又出现")
    (async (_e: never, id: number) => {
      const doomed = tasks.collectSubtreeIds(id)
      const mdPath = deps.mdSync?.currentPath?.() ?? ''
      if (mdPath && deps.mdSync?.removeTask) {
        for (const tid of doomed) {
          try {
            await deps.mdSync.removeTask(mdPath, tid) // 串行:每次调用都会重写整份 MD
          } catch {
            /* best-effort,MD 清理失败不阻塞 DB 删除 */
          }
        }
      }
      return tasks.deleteTask(id)
    }) as never,
  )
  reg.handle('todo:delete-all-tasks', (() => {
    timerManager.cancelAll()
    tasks.deleteAllTasks()
  }) as never)
  reg.handle('todo:get-suggestions', ((_e: never, maxMinutes?: number) => tasks.getSuggestions(maxMinutes)) as never)

  // 计时域
  reg.on('todo:start-focus', ((_e: never, taskId: number) => startFocusWithRotation(deps, taskId)) as never)
  reg.on('todo:stop-focus', (() => timerManager.stopFocus()) as never)
  reg.on('todo:complete-task', ((_e: never, taskId: number) => timerManager.completeTask(taskId)) as never)
  reg.on('todo:start-wait', ((_e: never, taskId: number, seconds: number) => timerManager.startWait(taskId, seconds)) as never)
  reg.on('todo:cancel-wait', ((_e: never, taskId: number) => timerManager.cancelWait(taskId)) as never)
  reg.on('todo:add-memo', ((_e: never, taskId: number, content: string) => tasks.appendMemo(taskId, content)) as never)
  reg.handle('todo:start-training', ((_e: never, taskId: number, gpuId: number, seconds: number) =>
    timerManager.startTraining(taskId, gpuId, seconds)) as never)
  reg.handle('todo:pause-training', ((_e: never, taskId: number) => timerManager.pauseTraining(taskId)) as never)
  reg.handle('todo:stop-training', ((_e: never, taskId: number, force?: boolean) =>
    timerManager.stopTraining(taskId, force)) as never)
  reg.handle('todo:snooze', ((_e: never, taskId: number, minutes: number) =>
    timerManager.snoozeTrainingReminder(taskId, minutes)) as never)

  // 任务项目（独立于类型树）
  reg.handle('todo:list-task-projects', (() => tasks.listTaskProjects()) as never)
  reg.handle('todo:create-task-project', ((_e: never, name: string, color?: string) =>
    tasks.createTaskProject(name, color)) as never)
  reg.handle('todo:update-task-project', ((_e: never, id: number, updates: { name?: string; color?: string | null }) =>
    tasks.updateTaskProject(id, updates)) as never)
  reg.handle('todo:delete-task-project', ((_e: never, id: number) => {
    tasks.deleteTaskProject(id)
    return true
  }) as never)

  // AI 域
  reg.handle('todo:ai-promote', ((_e: never, source: string, title: string, detail?: string, link?: string) =>
    ai.promote(source, title, detail, link)) as never)
  // 语义规格 §3.5：渲染端本地点击原样转发到所有窗口（带 id 单卡删；source/title 才动任务），force 不转发
  reg.on('todo:ai-dismiss', ((_e: never, payload: { id?: string; source?: string; title?: string; force?: boolean }) => {
    if (payload?.source || payload?.title) {
      ai.dismiss({ source: payload.source, title: payload.title })
    } else if (payload?.id) {
      deps.broadcastAiDismissed?.({ id: payload.id })
    }
  }) as never)
  reg.handle('todo:open-external', ((_e: never, url: string) => deps.openExternal?.(url)) as never)
  reg.handle('todo:training-status', (() => deps.trainingStatusSnapshot?.() ?? []) as never)
  reg.handle(
    'todo:set-shortcut',
    ((_e: never, accelerator: string) => deps.setShortcut?.(accelerator) ?? false) as never,
  )

  // GPU 域
  reg.handle('todo:get-gpus', (() => gpus.getAllGpus()) as never)
  reg.handle('todo:create-gpu', ((_e: never, name: string) => gpus.createGpu(name)) as never)
  reg.handle('todo:delete-gpu', ((_e: never, id: number) => {
    for (const rec of [...timerManager.trainingStatus.values()]) {
      if (rec.gpuName === gpus.getGpu(id)?.name) timerManager.removeTrainingStatus(rec.taskId)
    }
    gpus.deleteGpu(id)
  }) as never)
  reg.on('todo:assign-gpu', ((_e: never, taskId: number, gpuId: number, minutes: number) =>
    timerManager.startTraining(taskId, gpuId, Math.ceil(minutes) * 60)) as never)

  // Reminder 域
  reg.on('todo:reminder-hide', (() => deps.hideReminder?.()) as never)
  reg.on('todo:hide-spotlight', (() => deps.hideSpotlight?.()) as never)

  // Overlay 域
  reg.on('todo:set-overlay-ignore-mouse', ((_e: never, ignore: boolean) =>
    deps.setOverlayIgnoreMouse?.(ignore)) as never)
  reg.on('todo:reset-overlay-position', (() => deps.resetOverlayPosition?.()) as never)

  // 时间轴窄条：专注会话 + 合规分析
  reg.handle('todo:focus-sessions', ((_e: never, day: string) => deps.focusSessions?.(day) ?? []) as never)
  reg.handle('todo:session-analyses', ((_e: never, day: string) => deps.sessionAnalyses?.(day) ?? []) as never)
  reg.handle('todo:session-segments', ((_e: never, day: string) => deps.sessionSegments?.(day) ?? []) as never)
  reg.handle('todo:analyze-day', ((_e: never, day: string) => deps.analyzeDay?.(day) ?? Promise.resolve(0)) as never)

  // wandb 域
  reg.handle(
    'wandb:test',
    ((_e: never, entity: string, apiKey: string) =>
      deps.wandbTest?.(entity, apiKey) ??
      Promise.resolve({ valid: false, projectCount: 0, hostname: '', error: 'not wired' })) as never,
  )
  reg.on('wandb:update', (() => deps.wandbUpdate?.()) as never)

  // MD 同步域（语义规格 §10；协议语义按功能清单 §七）
  reg.handle('md-sync:select-folder', (() => deps.mdSync?.selectFolder() ?? Promise.resolve(null)) as never)
  reg.handle(
    'md-sync:set-config',
    ((_e: never, enabled: boolean, folder: string) => deps.mdSync?.setConfig(enabled, folder) ?? Promise.resolve()) as never,
  )
  reg.handle('md-sync:get-status', (() => deps.mdSync?.getStatus() ?? Promise.resolve(null)) as never)
  reg.handle(
    'md-sync:import',
    ((_e: never, filePath: string, force: boolean) => deps.mdSync?.importFile(filePath, force) ?? Promise.resolve(null)) as never,
  )
  reg.handle(
    'md-sync:export',
    ((_e: never, folder: string) => deps.mdSync?.exportTo(folder) ?? Promise.resolve()) as never,
  )
  reg.handle(
    'md-sync:sync',
    ((_e: never, folder: string) => deps.mdSync?.syncNow(folder) ?? Promise.resolve(null)) as never,
  )
  reg.handle(
    'md-sync:check-file',
    ((_e: never, folder: string) => deps.mdSync?.checkFile(folder) ?? Promise.resolve(null)) as never,
  )
  reg.handle(
    'md-sync:check-duplicates',
    ((_e: never, titles: string[]) => deps.mdSync?.checkDuplicates(titles) ?? Promise.resolve([])) as never,
  )
  reg.handle('md-sync:read-file', ((_e: never, filePath: string) => deps.mdSync?.readFile(filePath) ?? Promise.resolve('')) as never)

  // 数据域（§十四：导出/导入 .db + 清空任务数据）
  reg.handle('todo:export-data', (() => deps.data?.exportData() ?? Promise.resolve(null)) as never)
  reg.handle('todo:import-data', (() => deps.data?.importData() ?? Promise.resolve(null)) as never)
  reg.handle('todo:clear-data', (() => {
    deps.data?.clearTodoData()
    return true
  }) as never)
  reg.on('todo:reminder-snooze', ((_e: never, taskId: number, minutes: number) => {
    timerManager.snoozeTrainingReminder(taskId, minutes)
    deps.hideReminder?.()
  }) as never)

  // 设置域
  reg.handle('todo:get-settings', (() => deps.getSettings()) as never)
  reg.handle('todo:update-settings', ((_e: never, patch: DeepPartial<TodoSettings>) => deps.saveSettings(patch)) as never)

  // 今日专注秒数（Spotlight footer 真实统计，附 C 决定 #4）
  reg.handle('todo:focus-today', (() => {
    const day = new Date().toISOString().slice(0, 10)
    const row = deps.tasks.getFocusSecondsForDay(day)
    return row
  }) as never)

  // Spotlight 命令执行（主进程同步适配真实服务；渲染端传解析结果+上下文 id）
  reg.handle(
    'todo:exec-command',
    ((
      _e: never,
      parsed: ParsedCommand,
      ctx: { activeTaskId?: number | null; highlightedId?: number | null; suggestionIds?: number[] },
    ): ExecResult => {
      const ops = makeMainDomainOps(deps)
      const all = ops.getTasks()
      return executeCommand(parsed, {
        activeTask: (ctx.activeTaskId != null ? all.find((t) => t.id === ctx.activeTaskId) : null) ?? null,
        highlighted: (ctx.highlightedId != null ? all.find((t) => t.id === ctx.highlightedId) : null) ?? null,
        suggestions: (ctx.suggestionIds ?? [])
          .map((id) => all.find((t) => t.id === id))
          .filter((t): t is TaskRow => Boolean(t)),
        domain: ops,
      })
    }) as never,
  )
  reg.handle(
    'todo:exec-gpu-pick',
    ((_e: never, draft: TrainingDraft, gpuId: number): ExecResult =>
      confirmGpuPick(
        { activeTask: null, highlighted: null, suggestions: [], domain: makeMainDomainOps(deps) },
        draft,
        gpuId,
      )) as never,
  )
}
