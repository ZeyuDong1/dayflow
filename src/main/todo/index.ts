/**
 * 任务域组合导出：一行装配 TaskService/GpuService/TimerManager。
 * P2 起被 ipc.ts / server.ts 使用；P1 仅导出供测试与后续接线。
 */
import type { TodoDB } from './db'
import { TaskService } from './service'
import { GpuService } from './gpu-service'
import { TimerManager, type TimerDeps } from './timer-manager'
import { getTodoSettings, type TodoSettings } from './settings'

export * from './db'
export * from './schema'
export * from './settings'
export * from './service'
export * from './gpu-service'
export * from './timer-manager'
export * from './priority'
export * from './hierarchy'
export * from './commands'

export interface TodoDomain {
  db: TodoDB
  tasks: TaskService
  gpus: GpuService
  timerManager: TimerManager
  getSettings: () => TodoSettings
}

export function createTodoDomain(
  db: TodoDB,
  opts: Omit<TimerDeps, 'db' | 'tasks' | 'gpus' | 'getSettings'>,
): TodoDomain {
  const tasks = new TaskService(db)
  const gpus = new GpuService(db)
  const getSettings = () => getTodoSettings(db)
  const timerManager = new TimerManager({ ...opts, db, tasks, gpus, getSettings })
  return { db, tasks, gpus, timerManager, getSettings }
}
