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

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  const gpus = new GpuService(db)
  clock = T0
  events = []
  tick = (ms) => (clock += ms)
  tm = new TimerManager({
    db,
    tasks,
    gpus,
    getSettings: () => DEFAULT_TODO_SETTINGS,
    broadcast: (e) => events.push(e),
    now: () => clock,
  })
})

describe('completeTask', () => {
  it('完成中任务且有父：焦点移交父并开始专注，自身时长先结算不丢', () => {
    const p = tasks.createTask('父')
    const c = tasks.createTask('子', { parentId: p.id, skipDedup: true })
    tm.startFocus(c.id)
    tick(200_000)
    tm.completeTask(c.id)
    expect(tasks.getTask(c.id)!.status).toBe('archived')
    expect(tasks.getTask(c.id)!.total_duration).toBe(200) // 结算不丢
    expect(tasks.getTask(p.id)!.status).toBe('active') // 父接棒
    expect(db.all("SELECT * FROM timers WHERE task_id = ? AND type = 'focus'", [p.id])).toHaveLength(1)
  })

  it('完成中任务且无父：stopFocus 结算', () => {
    const a = tasks.createTask('独苗')
    tm.startFocus(a.id)
    tick(200_000)
    tm.completeTask(a.id)
    expect(tasks.getTask(a.id)!.status).toBe('archived')
    expect(tasks.getTask(a.id)!.total_duration).toBe(200)
    expect(db.all("SELECT * FROM timers WHERE type = 'focus'")).toHaveLength(0)
  })

  it('级联归档自身+未归档后代并清其计时；已归档后代不受影响', () => {
    const p = tasks.createTask('父')
    const c1 = tasks.createTask('子1', { parentId: p.id, skipDedup: true })
    const gc = tasks.createTask('孙', { parentId: c1.id, skipDedup: true })
    const c2 = tasks.createTask('子2-已归档', { parentId: p.id, skipDedup: true })
    tasks.updateTask(c2.id, { status: 'archived' })
    tm.startWait(gc.id, 600) // 子孙有倒计时
    tm.completeTask(p.id)
    expect(tasks.getTask(p.id)!.status).toBe('archived')
    expect(tasks.getTask(c1.id)!.status).toBe('archived')
    expect(tasks.getTask(gc.id)!.status).toBe('archived')
    expect(tasks.getTask(c2.id)!.status).toBe('archived')
    expect(db.all('SELECT * FROM timers')).toHaveLength(0) // 计时清光
    expect(events.at(-1)).toEqual({ type: 'fetch-tasks' })
  })

  it('成环不死循环：环上节点与后代一并归档', () => {
    const a = tasks.createTask('a', { skipDedup: true })
    const b = tasks.createTask('b', { skipDedup: true })
    const c = tasks.createTask('c', { parentId: a.id, skipDedup: true })
    tasks.updateTask(a.id, { parent_id: b.id })
    tasks.updateTask(b.id, { parent_id: a.id })
    expect(() => tm.completeTask(a.id)).not.toThrow()
    expect(tasks.getTask(a.id)!.status).toBe('archived')
    expect(tasks.getTask(b.id)!.status).toBe('archived')
    expect(tasks.getTask(c.id)!.status).toBe('archived')
  })

  it('深度上限 20：超深子树只归档前 21 层（自身+20 层）', () => {
    const ids: number[] = []
    let parent: number | null = null
    for (let i = 0; i < 25; i++) {
      const t = tasks.createTask(`d${i}`, { parentId: parent, skipDedup: true })
      ids.push(t.id)
      parent = t.id
    }
    tm.completeTask(ids[0])
    for (let i = 0; i <= 20; i++) expect(tasks.getTask(ids[i])!.status).toBe('archived')
    for (let i = 21; i < 25; i++) expect(tasks.getTask(ids[i])!.status).toBe('queued')
  })
})
