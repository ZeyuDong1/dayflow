import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'

let db: MemDb
let svc: TaskService

beforeEach(async () => {
  db = await createMemDb()
  svc = new TaskService(db)
})

describe('TaskService.createTask', () => {
  it('默认值：queued / is_next_action=1 / total_duration=0 / sort_order 递增', () => {
    const a = svc.createTask('任务A')
    const b = svc.createTask('任务B')
    expect(a.status).toBe('queued')
    expect(a.is_next_action).toBe(1)
    expect(a.total_duration).toBe(0)
    expect(b.sort_order).toBeGreaterThanOrEqual(a.sort_order)
  })

  it('同名未归档去重返回旧任务；skipDedup 跳过；training 不去重', () => {
    const a1 = svc.createTask('同名')
    const a2 = svc.createTask('同名')
    expect(a2.id).toBe(a1.id)
    expect(svc.createTask('同名', { skipDedup: true }).id).not.toBe(a1.id)
    const t1 = svc.createTask('训练', { type: 'training' })
    const t2 = svc.createTask('训练', { type: 'training' })
    expect(t2.id).not.toBe(t1.id)
  })

  it('同名但已归档的任务不去重', () => {
    const a = svc.createTask('归档过的')
    svc.updateTask(a.id, { status: 'archived' })
    const b = svc.createTask('归档过的')
    expect(b.id).not.toBe(a.id)
  })
})

describe('TaskService.getAllTasks', () => {
  it('LEFT JOIN timers 返回虚拟字段；重复 timer 行保留信息多者', () => {
    const t = svc.createTask('带计时')
    db.run('INSERT INTO timers (task_id, type, started_at) VALUES (?, ?, ?)', [t.id, 'focus', '2026-01-01T00:00:00.000Z'])
    db.run('INSERT INTO timers (task_id, type) VALUES (?, ?)', [t.id, 'wait'])
    const rows = svc.getAllTasks()
    const row = rows.find((r) => r.id === t.id)!
    expect(row.timer_type).toBe('focus')
    expect(row.started_at).toBe('2026-01-01T00:00:00.000Z')
    expect(rows.filter((r) => r.id === t.id)).toHaveLength(1)
  })
})

describe('TaskService.updateTask', () => {
  it('禁改 started_at/target_timestamp/timer_type/is_webhook（静默忽略）', () => {
    const t = svc.createTask('守卫')
    const updated = svc.updateTask(t.id, {
      title: '改名',
      started_at: 'hack',
      target_timestamp: 'hack',
      timer_type: 'wait' as never,
      is_webhook: 1,
    })
    expect(updated!.title).toBe('改名')
    expect(updated!.started_at ?? null).toBeNull()
    expect(updated!.target_timestamp ?? null).toBeNull()
    expect(updated!.is_webhook).toBe(0)
  })
})

describe('TaskService.appendMemo', () => {
  it('空则直写，否则换行追加', () => {
    const t = svc.createTask('备注')
    svc.appendMemo(t.id, '第一行')
    svc.appendMemo(t.id, '第二行')
    expect(svc.getTask(t.id)!.context_memo).toBe('第一行\n第二行')
    const u = svc.createTask('空备注', { skipDedup: true })
    svc.appendMemo(u.id, '直接写')
    expect(svc.getTask(u.id)!.context_memo).toBe('直接写')
  })
})

describe('TaskService.getSuggestions', () => {
  it('queued 且估计时长 ≤ 上限，限 5 条', () => {
    for (let i = 0; i < 7; i++) svc.createTask(`s${i}`, { skipDedup: true, estimated_duration: i })
    expect(svc.getSuggestions()).toHaveLength(5)
    const short = svc.getSuggestions(2)
    expect(short.every((t) => (t.estimated_duration ?? 0) <= 2)).toBe(true)
    expect(short).toHaveLength(3)
  })
})

describe('TaskService.deleteTask / deleteAllTasks', () => {
  it('递归删子树并清 timer 行，history 保留', () => {
    const p = svc.createTask('父')
    const c = svc.createTask('子', { parentId: p.id, skipDedup: true })
    db.run('INSERT INTO timers (task_id, type, started_at) VALUES (?, ?, ?)', [c.id, 'focus', '2026-01-01T00:00:00.000Z'])
    db.run('INSERT INTO history (task_id, title, type, start_time, end_time) VALUES (?, ?, ?, ?, ?)', [
      c.id, '子', 'focus', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
    ])
    const doomed = svc.deleteTask(p.id)
    expect(doomed.sort()).toEqual([p.id, c.id].sort())
    expect(svc.getAllTasks()).toHaveLength(0)
    expect(db.all('SELECT * FROM timers')).toHaveLength(0)
    expect(db.all('SELECT * FROM history')).toHaveLength(1)
  })

  it('成环不死循环：两节点一并删除', () => {
    const a = svc.createTask('a', { skipDedup: true })
    const b = svc.createTask('b', { skipDedup: true })
    svc.updateTask(a.id, { parent_id: b.id })
    svc.updateTask(b.id, { parent_id: a.id })
    const doomed = svc.deleteTask(a.id)
    expect(doomed.sort()).toEqual([a.id, b.id].sort())
  })

  it('deleteAllTasks 清 tasks+history+timer 行', () => {
    const t = svc.createTask('全清')
    db.run('INSERT INTO timers (task_id, type, started_at) VALUES (?, ?, ?)', [t.id, 'focus', '2026-01-01T00:00:00.000Z'])
    db.run('INSERT INTO history (task_id, title, type, start_time, end_time) VALUES (?, ?, ?, ?, ?)', [
      t.id, '全清', 'focus', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
    ])
    svc.deleteAllTasks()
    expect(db.all('SELECT * FROM tasks')).toHaveLength(0)
    expect(db.all('SELECT * FROM history')).toHaveLength(0)
    expect(db.all('SELECT * FROM timers')).toHaveLength(0)
  })
})
