import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import { GpuService } from '../../src/main/todo/gpu-service'
import { TimerManager, type TimerEvent } from '../../src/main/todo/timer-manager'
import { DEFAULT_TODO_SETTINGS } from '../../src/main/todo/settings'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

let db: MemDb
let tasks: TaskService
let tm: TimerManager
let events: TimerEvent[]
let clock: number
let tick: (ms: number) => void
let setNow: (ms: number) => void

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  const gpus = new GpuService(db)
  clock = T0
  events = []
  tick = (ms) => (clock += ms)
  setNow = (ms) => (clock = ms)
  tm = new TimerManager({
    db,
    tasks,
    gpus,
    getSettings: () => DEFAULT_TODO_SETTINGS,
    broadcast: (e) => events.push(e),
    now: () => clock,
  })
})

describe('focus', () => {
  it('startFocus：插 focus 行、置 active、广播 timer:update', () => {
    const a = tasks.createTask('A')
    tm.startFocus(a.id)
    const row = tasks.getTask(a.id)!
    expect(row.status).toBe('active')
    const timers = db.all<{ type: string; started_at: string }>('SELECT * FROM timers WHERE task_id = ?', [a.id])
    expect(timers).toHaveLength(1)
    expect(timers[0].type).toBe('focus')
    expect(events.at(-1)).toEqual({ type: 'timer:update' })
  })

  it('排他清场：其他非 training 的 active 降级回队列；training 不受影响', () => {
    const a = tasks.createTask('A')
    const c = tasks.createTask('C', { skipDedup: true })
    const tr = tasks.createTask('训练', { type: 'training' })
    tasks.updateTask(c.id, { status: 'active' })
    tasks.updateTask(tr.id, { status: 'active' })
    tm.startFocus(a.id)
    expect(tasks.getTask(c.id)!.status).toBe('queued')
    expect(tasks.getTask(tr.id)!.status).toBe('active')
  })

  it('结算 ≥180s 记账+祖先累加+写 history；<180s 丢弃时长但置 queued', () => {
    const p = tasks.createTask('父')
    const c = tasks.createTask('子', { parentId: p.id, skipDedup: true })
    tm.startFocus(c.id)
    tick(200_000) // 200s
    tm.stopFocus()
    expect(tasks.getTask(c.id)!.total_duration).toBe(200)
    expect(tasks.getTask(p.id)!.total_duration).toBe(200) // 祖先累加
    expect(tasks.getTask(c.id)!.status).toBe('queued')
    const hist = db.all<{ task_id: number; title: string; type: string }>('SELECT * FROM history')
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ task_id: c.id, title: '子', type: 'focus' })

    tm.startFocus(c.id)
    tick(100_000) // <180s 丢弃
    tm.stopFocus()
    expect(tasks.getTask(c.id)!.total_duration).toBe(200)
    expect(db.all('SELECT * FROM history')).toHaveLength(1)
    expect(tasks.getTask(c.id)!.status).toBe('queued')
  })

  it('审查重点#2：重复 focus 行全部结算', () => {
    const t = tasks.createTask('重复')
    db.run("INSERT INTO timers (task_id, type, started_at) VALUES (?, 'focus', ?)", [
      t.id,
      new Date(T0 - 300_000).toISOString(), // 300s
    ])
    db.run("INSERT INTO timers (task_id, type, started_at) VALUES (?, 'focus', ?)", [
      t.id,
      new Date(T0 - 100_000).toISOString(), // 100s
    ])
    tm.stopFocus()
    expect(db.all('SELECT * FROM timers')).toHaveLength(0)
    expect(tasks.getTask(t.id)!.total_duration).toBe(300) // 300s 记账，100s 丢弃
  })

  it('审查重点#5：时钟回拨 elapsed<0 按 0（不记账不写 history）', () => {
    const t = tasks.createTask('回拨')
    tm.startFocus(t.id)
    setNow(T0 - 5_000) // 回拨
    tm.stopFocus()
    expect(tasks.getTask(t.id)!.total_duration).toBe(0)
    expect(db.all('SELECT * FROM history')).toHaveLength(0)
    expect(tasks.getTask(t.id)!.status).toBe('queued')
  })

  it('started_at 为 null：只删行，不更新任务', () => {
    const t = tasks.createTask('空起跑')
    tasks.updateTask(t.id, { status: 'active' })
    db.run("INSERT INTO timers (task_id, type, started_at) VALUES (?, 'focus', NULL)", [t.id])
    tm.stopFocus()
    expect(db.all('SELECT * FROM timers')).toHaveLength(0)
    expect(tasks.getTask(t.id)!.status).toBe('active') // 不更新
    expect(db.all('SELECT * FROM history')).toHaveLength(0)
  })

  it('切换专注：结算旧 focus 防丢时长', () => {
    const a = tasks.createTask('A')
    const b = tasks.createTask('B')
    tm.startFocus(a.id)
    tick(200_000)
    tm.startFocus(b.id) // 结算 a（200s 记账）
    expect(tasks.getTask(a.id)!.total_duration).toBe(200)
    expect(tasks.getTask(a.id)!.status).toBe('queued')
    expect(tasks.getTask(b.id)!.status).toBe('active')
  })
})
