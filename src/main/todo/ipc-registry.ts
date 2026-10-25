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
  reg.handle('todo:update-task', ((_e: never, id: number, updates: Partial<TaskRow>) => tasks.updateTask(id, updates)) as never)
  reg.handle('todo:set-side-focus', ((_e: never, id: number, enabled: boolean) => tasks.setSideFocus(id, enabled)) as never)
  reg.handle('todo:delete-task', ((_e: never, id: number) => tasks.deleteTask(id)) as never)
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

  // AI 域
  reg.handle('todo:ai-promote', ((_e: never, source: string, title: string, detail?: string, link?: string) =>
    ai.promote(source, title, detail, link)) as never)
  reg.on('todo:ai-dismiss', ((_e: never, payload: { source?: string; title?: string; force?: boolean }) => {
    if (payload?.source || payload?.title) {
      ai.dismiss({ source: payload.source, title: payload.title, force: payload.force === true })
    }
  }) as never)

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
