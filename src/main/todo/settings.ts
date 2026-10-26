/**
 * 任务域设置（app_settings 表 `todo-settings` 键，JSON）。
 * 读取时逐项校验：非法值回退默认，绝不产生 0 间隔等疯转参数（审查重点 #3）。
 * 取值单位均为分钟；gpu_quiet_hours 为 0–23 整点，支持跨零点环绕。
 */
import type { TodoDB } from './db'

export interface OverlaySettings {
  opacity: number // 10–100 %，默认 80
  fontSize: number // 10–24 px，默认 14
  color: string // 文字颜色，默认 #ffffff
  mouseIgnore: boolean // 点击穿透，默认开
  focusGlowEnabled: boolean
  focusGlowIntensity: number // 2–14 px，默认 6
  focusGlowSpeed: number // 1–6 s，默认 3
  sideGlowEnabled: boolean
  focusMarqueeEnabled: boolean
  focusMarqueeSpeed: number // 10–100 px/s，默认 30
  sideMarqueeEnabled: boolean
}

export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface TodoSettings {
  reminder_nag_interval: number
  gpu_quiet_hours: { start: number; end: number }
  gpu_idle_interval: number
  webhook_stalled_threshold: number
  webhook_stalled_interval: number
  overlay_settings: OverlaySettings
  overlay_bounds: OverlayBounds
  wandb_api_key: string
  wandb_entity: string
  md_sync_enabled: boolean
  md_sync_folder: string
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export const DEFAULT_TODO_SETTINGS: TodoSettings = {
  reminder_nag_interval: 15,
  gpu_quiet_hours: { start: 23, end: 8 },
  gpu_idle_interval: 15,
  webhook_stalled_threshold: 5,
  webhook_stalled_interval: 10,
  overlay_settings: {
    opacity: 80,
    fontSize: 14,
    color: '#ffffff',
    mouseIgnore: true,
    focusGlowEnabled: true,
    focusGlowIntensity: 6,
    focusGlowSpeed: 3,
    sideGlowEnabled: true,
    focusMarqueeEnabled: true,
    focusMarqueeSpeed: 30,
    sideMarqueeEnabled: true,
  },
  overlay_bounds: { x: 100, y: 100, width: 350, height: 250 },
  wandb_api_key: '',
  wandb_entity: '',
  md_sync_enabled: false,
  md_sync_folder: '',
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

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
}

function overlaySettings(v: unknown): OverlaySettings {
  const d = DEFAULT_TODO_SETTINGS.overlay_settings
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    opacity: clampInt(o.opacity, 10, 100, d.opacity),
    fontSize: clampInt(o.fontSize, 10, 24, d.fontSize),
    color: typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : d.color,
    mouseIgnore: typeof o.mouseIgnore === 'boolean' ? o.mouseIgnore : d.mouseIgnore,
    focusGlowEnabled: typeof o.focusGlowEnabled === 'boolean' ? o.focusGlowEnabled : d.focusGlowEnabled,
    focusGlowIntensity: clampInt(o.focusGlowIntensity, 2, 14, d.focusGlowIntensity),
    focusGlowSpeed:
      typeof o.focusGlowSpeed === 'number' && o.focusGlowSpeed >= 1 && o.focusGlowSpeed <= 6
        ? o.focusGlowSpeed
        : d.focusGlowSpeed,
    sideGlowEnabled: typeof o.sideGlowEnabled === 'boolean' ? o.sideGlowEnabled : d.sideGlowEnabled,
    focusMarqueeEnabled:
      typeof o.focusMarqueeEnabled === 'boolean' ? o.focusMarqueeEnabled : d.focusMarqueeEnabled,
    focusMarqueeSpeed: clampInt(o.focusMarqueeSpeed, 10, 100, d.focusMarqueeSpeed),
    sideMarqueeEnabled: typeof o.sideMarqueeEnabled === 'boolean' ? o.sideMarqueeEnabled : d.sideMarqueeEnabled,
  }
}

function overlayBounds(v: unknown): OverlayBounds {
  const d = DEFAULT_TODO_SETTINGS.overlay_bounds
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const x = Number(o.x)
  const y = Number(o.y)
  const w = Number(o.width)
  const h = Number(o.height)
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { x, y, width: w, height: h }
  }
  return { ...d }
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
    overlay_settings: overlaySettings(raw.overlay_settings),
    overlay_bounds: overlayBounds(raw.overlay_bounds),
    wandb_api_key: typeof raw.wandb_api_key === 'string' ? raw.wandb_api_key : DEFAULT_TODO_SETTINGS.wandb_api_key,
    wandb_entity: typeof raw.wandb_entity === 'string' ? raw.wandb_entity : DEFAULT_TODO_SETTINGS.wandb_entity,
    md_sync_enabled: typeof raw.md_sync_enabled === 'boolean' ? raw.md_sync_enabled : DEFAULT_TODO_SETTINGS.md_sync_enabled,
    md_sync_folder: typeof raw.md_sync_folder === 'string' ? raw.md_sync_folder : DEFAULT_TODO_SETTINGS.md_sync_folder,
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
    overlay_settings: patch.overlay_settings
      ? { ...current.overlay_settings, ...patch.overlay_settings }
      : current.overlay_settings,
    overlay_bounds: patch.overlay_bounds ? { ...current.overlay_bounds, ...patch.overlay_bounds } : current.overlay_bounds,
    wandb_api_key: patch.wandb_api_key ?? current.wandb_api_key,
    wandb_entity: patch.wandb_entity ?? current.wandb_entity,
    md_sync_enabled: patch.md_sync_enabled ?? current.md_sync_enabled,
    md_sync_folder: patch.md_sync_folder ?? current.md_sync_folder,
  }
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
    TODO_SETTINGS_KEY,
    JSON.stringify(merged),
  ])
  return getTodoSettings(db)
}
