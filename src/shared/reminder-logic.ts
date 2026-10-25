/**
 * Reminder 窗纯逻辑（语义规格 §2.5/§5.4）：键盘动作语义与计时显示格式化。
 * 无任何依赖，渲染端与测试共用。
 */

export type ReminderActionKind = 'complete' | 'dismiss' | 'stop-training' | 'select-project' | 'snooze'

export interface ReminderAction {
  kind: ReminderActionKind
  minutes?: number
}

export interface ReminderActionInput {
  key: 'enter' | 'esc'
  /** 任务类型；伪任务为 'gpu-idle' / 'notification'（合成硬提醒） */
  taskType: string
  hasProject: boolean
}

/** Enter/Esc 动作语义：training 完成走 stopTraining、gpu-idle/notification 仅关闭、无项目 standard 先选项目。 */
export function resolveReminderAction(input: ReminderActionInput): ReminderAction {
  if (input.key === 'esc') {
    // Esc：training = 负时（默认 15 分钟），其余 = 关闭
    return input.taskType === 'training' ? { kind: 'snooze', minutes: 15 } : { kind: 'dismiss' }
  }
  if (input.taskType === 'training') return { kind: 'stop-training' }
  if (input.taskType === 'gpu-idle' || input.taskType === 'notification') return { kind: 'dismiss' }
  if (input.taskType === 'standard' && !input.hasProject) return { kind: 'select-project' }
  return { kind: 'complete' }
}

/** snooze 默认分钟数：training 负时 15，其余 5。 */
export function defaultSnoozeMinutes(taskType: string): number {
  return taskType === 'training' ? 15 : 5
}

export interface TimerDisplayTask {
  total_duration?: number
  started_at?: string | null
  target_timestamp?: string | null
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}:${pad(h)}:${pad(m)}:${pad(sec)}`
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`
  return `${pad(m)}:${pad(sec)}`
}

/**
 * 计时显示：倒计时优先（target-now；≤-2s="DONE"、≤0="00:00"）；
 * 其次秒表（total_duration + 进行中秒数）。分段格式 D:HH:MM:SS / HH:MM:SS / MM:SS。
 */
export function getTimerDisplay(task: TimerDisplayTask, now: number): string {
  if (task.target_timestamp != null) {
    const diff = Date.parse(task.target_timestamp) - now
    if (diff <= -2000) return 'DONE'
    if (diff <= 0) return '00:00'
    return formatSeconds(diff / 1000)
  }
  if (task.started_at != null) {
    const elapsed = Math.max(0, Math.floor((now - Date.parse(task.started_at)) / 1000))
    return formatSeconds((task.total_duration ?? 0) + elapsed)
  }
  return formatSeconds(task.total_duration ?? 0)
}
