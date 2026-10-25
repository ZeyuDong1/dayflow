/**
 * 任务域设置（app_settings 表 `todo-settings` 键，JSON）。
 * 读取时逐项校验：非法值回退默认，绝不产生 0 间隔等疯转参数（审查重点 #3）。
 * 取值单位均为分钟；gpu_quiet_hours 为 0–23 整点，支持跨零点环绕。
 */
import type { TodoDB } from './db'

export interface TodoSettings {
  reminder_nag_interval: number
  gpu_quiet_hours: { start: number; end: number }
  gpu_idle_interval: number
  webhook_stalled_threshold: number
  webhook_stalled_interval: number
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export const DEFAULT_TODO_SETTINGS: TodoSettings = {
  reminder_nag_interval: 15,
  gpu_quiet_hours: { start: 23, end: 8 },
  gpu_idle_interval: 15,
  webhook_stalled_threshold: 5,
  webhook_stalled_interval: 10,
}

export const TODO_SETTINGS_KEY = 'todo-settings'

function positiveMinutes(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : fallback
}

function quietHours(v: unknown): { start: number; end: number } {
  if (v && typeof v === 'object') {
    const { start, end } = v as { start?: unknown; end?: unknown }
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 23
    if (ok(start) && ok(end)) return { start: start as number, end: end as number }
  }
  return { ...DEFAULT_TODO_SETTINGS.gpu_quiet_hours }
}

export function getTodoSettings(db: TodoDB): TodoSettings {
  const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [TODO_SETTINGS_KEY])
  let raw: Record<string, unknown> = {}
  if (row?.value) {
    try {
      raw = JSON.parse(row.value)
    } catch {
      raw = {}
    }
  }
  return {
    reminder_nag_interval: positiveMinutes(raw.reminder_nag_interval, DEFAULT_TODO_SETTINGS.reminder_nag_interval),
    gpu_quiet_hours: quietHours(raw.gpu_quiet_hours),
    gpu_idle_interval: positiveMinutes(raw.gpu_idle_interval, DEFAULT_TODO_SETTINGS.gpu_idle_interval),
    webhook_stalled_threshold: positiveMinutes(raw.webhook_stalled_threshold, DEFAULT_TODO_SETTINGS.webhook_stalled_threshold),
    webhook_stalled_interval: positiveMinutes(raw.webhook_stalled_interval, DEFAULT_TODO_SETTINGS.webhook_stalled_interval),
  }
}

export function saveTodoSettings(db: TodoDB, patch: DeepPartial<TodoSettings>): TodoSettings {
  const current = getTodoSettings(db)
  const merged: TodoSettings = {
    reminder_nag_interval: patch.reminder_nag_interval ?? current.reminder_nag_interval,
    gpu_quiet_hours: patch.gpu_quiet_hours
      ? { ...current.gpu_quiet_hours, ...patch.gpu_quiet_hours }
      : current.gpu_quiet_hours,
    gpu_idle_interval: patch.gpu_idle_interval ?? current.gpu_idle_interval,
    webhook_stalled_threshold: patch.webhook_stalled_threshold ?? current.webhook_stalled_threshold,
    webhook_stalled_interval: patch.webhook_stalled_interval ?? current.webhook_stalled_interval,
  }
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
    TODO_SETTINGS_KEY,
    JSON.stringify(merged),
  ])
  return getTodoSettings(db)
}
