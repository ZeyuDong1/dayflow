import { describe, it, expect } from 'vitest'
import {
  resolveReminderAction,
  defaultSnoozeMinutes,
  getTimerDisplay,
} from '../../src/main/todo/reminder-logic'

const T0 = Date.parse('2026-01-01T12:00:00')

describe('getTimerDisplay', () => {
  it('倒计时优先：分段格式与 DONE/00:00 边界', () => {
    expect(getTimerDisplay({ target_timestamp: new Date(T0 + 45_000).toISOString() }, T0)).toBe('00:45')
    expect(getTimerDisplay({ target_timestamp: new Date(T0 + 3_725_000).toISOString() }, T0)).toBe('01:02:05')
    expect(getTimerDisplay({ target_timestamp: new Date(T0 + 90_061_000).toISOString() }, T0)).toBe('1:01:01:01')
    expect(getTimerDisplay({ target_timestamp: new Date(T0).toISOString() }, T0)).toBe('00:00') // ≤0
    expect(getTimerDisplay({ target_timestamp: new Date(T0 - 1000).toISOString() }, T0)).toBe('00:00') // -1s
    expect(getTimerDisplay({ target_timestamp: new Date(T0 - 3000).toISOString() }, T0)).toBe('DONE') // ≤-2s
  })

  it('秒表：累计 + 进行中；超一天 D:HH:MM:SS', () => {
    expect(getTimerDisplay({ total_duration: 100, started_at: new Date(T0 - 55_000).toISOString() }, T0)).toBe('02:35')
    expect(getTimerDisplay({ total_duration: 86_400, started_at: new Date(T0).toISOString() }, T0)).toBe('1:00:00:00')
    expect(getTimerDisplay({ total_duration: 70 }, T0)).toBe('01:10')
  })
})

describe('resolveReminderAction', () => {
  it('Enter：training→stop-training；gpu-idle/notification→dismiss；无项目 standard→select-project；其余→complete', () => {
    expect(resolveReminderAction({ key: 'enter', taskType: 'training', hasProject: true })).toEqual({ kind: 'stop-training' })
    expect(resolveReminderAction({ key: 'enter', taskType: 'gpu-idle', hasProject: false })).toEqual({ kind: 'dismiss' })
    expect(resolveReminderAction({ key: 'enter', taskType: 'notification', hasProject: false })).toEqual({ kind: 'dismiss' })
    expect(resolveReminderAction({ key: 'enter', taskType: 'standard', hasProject: false })).toEqual({ kind: 'select-project' })
    expect(resolveReminderAction({ key: 'enter', taskType: 'standard', hasProject: true })).toEqual({ kind: 'complete' })
    expect(resolveReminderAction({ key: 'enter', taskType: 'reminder', hasProject: true })).toEqual({ kind: 'complete' })
  })

  it('Esc：training→snooze(15)；其余→dismiss', () => {
    expect(resolveReminderAction({ key: 'esc', taskType: 'training', hasProject: true })).toEqual({ kind: 'snooze', minutes: 15 })
    expect(resolveReminderAction({ key: 'esc', taskType: 'standard', hasProject: true })).toEqual({ kind: 'dismiss' })
  })

  it('snooze 默认：training 15 分钟，其余 5 分钟', () => {
    expect(defaultSnoozeMinutes('training')).toBe(15)
    expect(defaultSnoozeMinutes('standard')).toBe(5)
    expect(defaultSnoozeMinutes('reminder')).toBe(5)
  })
})
