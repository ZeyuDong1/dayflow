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
  it('默认值：nag 15、quiet 23→8、idle 15、stalled 5/10（分钟）', async () => {
    const db = await createMemDb()
    expect(getTodoSettings(db)).toEqual(DEFAULT_TODO_SETTINGS)
    expect(DEFAULT_TODO_SETTINGS).toEqual({
      reminder_nag_interval: 15,
      gpu_quiet_hours: { start: 23, end: 8 },
      gpu_idle_interval: 15,
      webhook_stalled_threshold: 5,
      webhook_stalled_interval: 10,
    })
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
