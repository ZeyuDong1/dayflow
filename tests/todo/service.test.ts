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

describe('side focus', () => {
  it('上限 2：满员返回 false 且不改动', () => {
    const a = svc.createTask('副A', { skipDedup: true })
    const b = svc.createTask('副B', { skipDedup: true })
    const c = svc.createTask('副C', { skipDedup: true })
    expect(svc.setSideFocus(a.id, true)).toBe(true)
    expect(svc.setSideFocus(b.id, true)).toBe(true)
    expect(svc.setSideFocus(c.id, true)).toBe(false)
    expect(svc.getTask(c.id)!.is_side_focus).toBe(0)
    expect(svc.setSideFocus(a.id, false)).toBe(true) // 释放后可再设
    expect(svc.setSideFocus(c.id, true)).toBe(true)
  })

  it('archived/active 带旗任务不占额度', () => {
    const a = svc.createTask('占位A', { skipDedup: true })
    const b = svc.createTask('占位B', { skipDedup: true })
    const c = svc.createTask('占位C', { skipDedup: true })
    const d = svc.createTask('占位D', { skipDedup: true })
    expect(svc.setSideFocus(a.id, true)).toBe(true)
    expect(svc.setSideFocus(b.id, true)).toBe(true)
    expect(svc.setSideFocus(c.id, true)).toBe(false) // 满员
    svc.updateTask(a.id, { status: 'active' }) // A 升主焦点 → 释放额度
    expect(svc.setSideFocus(c.id, true)).toBe(true)
    svc.updateTask(b.id, { status: 'archived' }) // 归档也释放额度
    expect(svc.setSideFocus(d.id, true)).toBe(true)
  })

  it('pickSideFocusPromotion 排序键：历史新者优先，无历史按最早打旗，NULL 视为最老', () => {
    const t1 = svc.createTask('p1', { skipDedup: true })
    const t2 = svc.createTask('p2', { skipDedup: true })
    const t3 = svc.createTask('p3', { skipDedup: true })
    const t4 = svc.createTask('p4', { skipDedup: true })
    svc.updateTask(t1.id, { last_focused_at: '2026-01-02T00:00:00.000Z', side_focus_at: '2026-01-01T00:00:00.000Z', is_side_focus: 1 })
    svc.updateTask(t2.id, { last_focused_at: '2026-01-01T00:00:00.000Z', side_focus_at: '2026-01-02T00:00:00.000Z', is_side_focus: 1 })
    svc.updateTask(t3.id, { last_focused_at: null, side_focus_at: '2026-01-03T00:00:00.000Z', is_side_focus: 1 })
    svc.updateTask(t4.id, { last_focused_at: null, side_focus_at: '2026-01-04T00:00:00.000Z', is_side_focus: 1 })
    // 有历史组：t1(01-02) 新于 t2(01-01)；无历史组：t3(01-03) 早于 t4(01-04)
    expect(svc.pickSideFocusPromotion(0)).toBe(t1.id)
    expect(svc.pickSideFocusPromotion(t1.id)).toBe(t2.id)
    expect(svc.pickSideFocusPromotion(t2.id)).toBe(t1.id)
    svc.updateTask(t1.id, { status: 'archived' })
    svc.updateTask(t2.id, { status: 'archived' })
    expect(svc.pickSideFocusPromotion(0)).toBe(t3.id) // 无历史组按最早打旗
  })

  it('pickSideFocusPromotion 排除 excludeId 与 archived/active', () => {
    const t = svc.createTask('单', { skipDedup: true })
    svc.updateTask(t.id, { is_side_focus: 1, side_focus_at: '2026-01-01T00:00:00.000Z' })
    expect(svc.pickSideFocusPromotion(t.id)).toBeNull()
    expect(svc.pickSideFocusPromotion(0)).toBe(t.id)
    svc.updateTask(t.id, { status: 'archived' })
    expect(svc.pickSideFocusPromotion(0)).toBeNull()
  })
})
