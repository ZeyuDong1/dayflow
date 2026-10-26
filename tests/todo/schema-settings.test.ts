import { describe, it, expect } from 'vitest'
import { createMemDb } from '../helpers/memdb'
import { TODO_SCHEMA_SQL } from '../../src/main/todo/schema'
import { getTodoSettings, saveTodoSettings, DEFAULT_TODO_SETTINGS } from '../../src/main/todo/settings'

describe('todo schema', () => {
  it('建表幂等：TODO_SCHEMA_SQL 重复执行不报错', async () => {
    const db = await createMemDb()
    expect(() => db.exec(TODO_SCHEMA_SQL)).not.toThrow()
  })

  it('五表存在', async () => {
    const db = await createMemDb()
    const names = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    for (const t of ['task_projects', 'tasks', 'timers', 'history', 'gpus']) {
      expect(names).toContain(t)
    }
  })

  it('timers.task_id 外键 ON DELETE CASCADE 指向 tasks', async () => {
    const db = await createMemDb()
    const fk = db.all<{ table: string; from: string; on_delete: string }>('PRAGMA foreign_key_list(timers)')
    expect(fk[0]).toMatchObject({ table: 'tasks', from: 'task_id', on_delete: 'CASCADE' })
  })
})

describe('todo settings', () => {
  it('默认值：nag 15、quiet 23→8、idle 15、stalled 5/10（分钟）+ overlay 默认', async () => {
    const db = await createMemDb()
    expect(getTodoSettings(db)).toEqual(DEFAULT_TODO_SETTINGS)
    expect(DEFAULT_TODO_SETTINGS.reminder_nag_interval).toBe(15)
    expect(DEFAULT_TODO_SETTINGS.gpu_quiet_hours).toEqual({ start: 23, end: 8 })
    expect(DEFAULT_TODO_SETTINGS.gpu_idle_interval).toBe(15)
    expect(DEFAULT_TODO_SETTINGS.webhook_stalled_threshold).toBe(5)
    expect(DEFAULT_TODO_SETTINGS.webhook_stalled_interval).toBe(10)
    expect(DEFAULT_TODO_SETTINGS.overlay_settings).toEqual({
      opacity: 80,
      fontSize: 14,
      fontWeight: 400,
      focusFontScale: 1.8,
      sideFontScale: 1.25,
      color: '#ffffff',
      mouseIgnore: true,
      focusGlowEnabled: true,
      focusGlowIntensity: 6,
      focusGlowSpeed: 3,
      sideGlowEnabled: true,
      focusMarqueeEnabled: true,
      focusMarqueeSpeed: 30,
      sideMarqueeEnabled: true,
    })
    expect(DEFAULT_TODO_SETTINGS.overlay_bounds).toEqual({ x: 100, y: 100, width: 350, height: 250 })
  })

  it('overlay 设置非法值回退（越界/坏色值/坏 bounds）', async () => {
    const db = await createMemDb()
    db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
      'todo-settings',
      JSON.stringify({
        overlay_settings: { opacity: 5, fontSize: 99, color: 'red', focusGlowIntensity: 100 },
        overlay_bounds: { x: 'x', y: 0, width: -1, height: 250 },
      }),
    ])
    const s = getTodoSettings(db)
    expect(s.overlay_settings.opacity).toBe(80)
    expect(s.overlay_settings.fontSize).toBe(14)
    expect(s.overlay_settings.focusFontScale).toBe(1.8)
    expect(s.overlay_settings.sideFontScale).toBe(1.25)
    expect(s.overlay_settings.color).toBe('#ffffff')
    expect(s.overlay_settings.focusGlowIntensity).toBe(6)
    expect(s.overlay_bounds).toEqual({ x: 100, y: 100, width: 350, height: 250 })
  })

  it('非法值回退默认（审查重点 #3：绝不返回 0 间隔）', async () => {
    const db = await createMemDb()
    db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
      'todo-settings',
      JSON.stringify({
        reminder_nag_interval: 0,
        gpu_idle_interval: -3,
        webhook_stalled_threshold: 'x',
        webhook_stalled_interval: null,
        gpu_quiet_hours: { start: 30, end: 8 },
      }),
    ])
    expect(getTodoSettings(db)).toEqual(DEFAULT_TODO_SETTINGS)
    expect(getTodoSettings(db).reminder_nag_interval).toBeGreaterThan(0)
  })

  it('JSON 损坏时回退默认', async () => {
    const db = await createMemDb()
    db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', ['todo-settings', '{bad json'])
    expect(getTodoSettings(db)).toEqual(DEFAULT_TODO_SETTINGS)
  })

  it('roundtrip：patch 合并写入并读回', async () => {
    const db = await createMemDb()
    saveTodoSettings(db, { reminder_nag_interval: 7 })
    saveTodoSettings(db, { gpu_quiet_hours: { start: 1, end: 2 } })
    const s = getTodoSettings(db)
    expect(s.reminder_nag_interval).toBe(7)
    expect(s.gpu_quiet_hours).toEqual({ start: 1, end: 2 })
    expect(s.gpu_idle_interval).toBe(15) // 未 patch 的键保留
  })
})
