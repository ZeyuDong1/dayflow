import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import { GpuService } from '../../src/main/todo/gpu-service'
import { TimerManager, type TimerEvent } from '../../src/main/todo/timer-manager'
import { DEFAULT_TODO_SETTINGS } from '../../src/main/todo/settings'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

let db: MemDb
let tasks: TaskService
let gpus: GpuService
let tm: TimerManager
let events: TimerEvent[]
let notifies: { title: string; body: string; silent?: boolean }[]
let clock: number
let tick: (ms: number) => void

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  gpus = new GpuService(db)
  clock = T0
  events = []
  notifies = []
  tick = (ms) => (clock += ms)
  tm = new TimerManager({
    db,
    tasks,
    gpus,
    getSettings: () => DEFAULT_TODO_SETTINGS,
    broadcast: (e) => events.push(e),
    now: () => clock,
    notify: (o) => notifies.push(o),
  })
})

describe('wait', () => {
  it('startWait 先结算同任务 focus（不丢时长）；每任务 timer 行唯一', () => {
    const a = tasks.createTask('A')
    tm.startFocus(a.id)
    tick(200_000)
    tm.startWait(a.id, 600)
    expect(tasks.getTask(a.id)!.total_duration).toBe(200)
    expect(tasks.getTask(a.id)!.status).toBe('waiting')
    const rows = db.all<{ type: string }>('SELECT * FROM timers WHERE task_id = ?', [a.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('wait')
  })

  it('cancelWait：training/reminder 整任务删除（有 GPU 先释放）；其余回 queued；archived 不动', () => {
    const r = tasks.createTask('家务', { type: 'reminder' })
    tm.startWait(r.id, 60)
    tm.cancelWait(r.id)
    expect(tasks.getTask(r.id)).toBeUndefined()

    const g = gpus.createGpu('4090')
    const t = tasks.createTask('训练', { type: 'training' })
    tm.startTraining(t.id, g.id, 60)
    tm.cancelWait(t.id)
    expect(tasks.getTask(t.id)).toBeUndefined()
    expect(gpus.getGpu(g.id)!.last_active_at).not.toBeNull() // GPU 已释放

    const s = tasks.createTask('普通', { skipDedup: true })
    tm.startWait(s.id, 60)
    tm.cancelWait(s.id)
    expect(tasks.getTask(s.id)!.status).toBe('queued')

    const arch = tasks.createTask('已归档', { skipDedup: true })
    tm.startWait(arch.id, 60)
    tasks.updateTask(arch.id, { status: 'archived' })
    tm.cancelWait(arch.id)
    expect(tasks.getTask(arch.id)!.status).toBe('archived')
  })

  it('snooze 改 target 不改 original_duration，status 不变', () => {
    const a = tasks.createTask('贪睡', { skipDedup: true })
    tm.startWait(a.id, 600)
    tm.snoozeTrainingReminder(a.id, 5)
    const row = db.get<{ target_timestamp: string; original_duration: number }>(
      'SELECT * FROM timers WHERE task_id = ?',
      [a.id],
    )!
    expect(row.original_duration).toBe(600)
    expect(Date.parse(row.target_timestamp)).toBe(T0 + 5 * 60000)
    expect(tasks.getTask(a.id)!.status).toBe('waiting')
  })
})

describe('training', () => {
  it('startTraining GPU 被占自动 pauseTraining 旧任务（回队列、清 gpu_id、GPU 状态一致）', () => {
    const g = gpus.createGpu('A100')
    const t1 = tasks.createTask('t1', { type: 'training', skipDedup: true })
    const t2 = tasks.createTask('t2', { type: 'training', skipDedup: true })
    tm.startTraining(t1.id, g.id, 3600)
    expect(tasks.getTask(t1.id)!.status).toBe('active')
    expect(gpus.getGpu(g.id)!.last_active_at).toBeNull() // busy
    tm.startTraining(t2.id, g.id, 3600)
    expect(tasks.getTask(t1.id)!.status).toBe('queued')
    expect(tasks.getTask(t1.id)!.gpu_id).toBeNull()
    expect(tasks.getTask(t2.id)!.status).toBe('active')
    expect(tasks.getTask(t2.id)!.gpu_id).toBe(g.id)
  })

  it('stopTraining 未完成 → 回队列；已完成/force → 归档并建 "Process {原标题}" 跟进', () => {
    const g = gpus.createGpu('A100')
    const t1 = tasks.createTask('t1', { type: 'training', skipDedup: true })
    tm.startTraining(t1.id, g.id, 3600)
    tm.stopTraining(t1.id)
    expect(tasks.getTask(t1.id)!.status).toBe('queued')
    expect(tasks.getTask(t1.id)!.gpu_id).toBeNull()
    expect(tasks.getAllTasks().some((t) => t.title === 'Process t1')).toBe(false)

    const t2 = tasks.createTask('t2', { type: 'training', skipDedup: true })
    tm.startTraining(t2.id, g.id, 60)
    tick(60_000) // 到期
    tm.stopTraining(t2.id)
    expect(tasks.getTask(t2.id)!.status).toBe('archived')
    expect(tasks.getAllTasks().some((t) => t.title === 'Process t2')).toBe(true)
    expect(gpus.getGpu(g.id)!.last_active_at).not.toBeNull() // GPU 释放
  })

  it('forceComplete 强制归档并建跟进任务', () => {
    const g = gpus.createGpu('A100')
    const t = tasks.createTask('t3', { type: 'training', skipDedup: true })
    tm.startTraining(t.id, g.id, 3600)
    tm.stopTraining(t.id, true)
    expect(tasks.getTask(t.id)!.status).toBe('archived')
    expect(tasks.getAllTasks().some((x) => x.title === 'Process t3')).toBe(true)
  })
})

describe('到期分流', () => {
  it('到期：不删行、不改 status；非 reminder 发静音通知；广播 timer:ended', () => {
    const s = tasks.createTask('普通到期', { skipDedup: true })
    tm.startWait(s.id, 60)
    tick(60_000)
    tm.handleTimerExpiration(s.id)
    expect(db.all('SELECT * FROM timers WHERE task_id = ?', [s.id])).toHaveLength(1) // 行保留
    expect(tasks.getTask(s.id)!.status).toBe('waiting') // status 不变
    expect(notifies).toHaveLength(1)
    expect(notifies[0]).toMatchObject({ title: 'Timer Finished', body: '普通到期', silent: true })
    expect(events.some((e) => e.type === 'timer:ended' && e.taskId === s.id)).toBe(true)
  })

  it('reminder 软路径：无通知，仅广播（横幅用）', () => {
    const r = tasks.createTask('软提醒', { type: 'reminder', skipDedup: true })
    tm.startWait(r.id, 60)
    tick(60_000)
    tm.handleTimerExpiration(r.id)
    expect(notifies).toHaveLength(0)
    expect(events.some((e) => e.type === 'timer:ended' && e.taskId === r.id)).toBe(true)
  })

  it('training 到期释放 GPU，通知标题为 Training Complete', () => {
    const g = gpus.createGpu('A100')
    const t = tasks.createTask('训练到期', { type: 'training', skipDedup: true })
    tm.startTraining(t.id, g.id, 60)
    tick(60_000)
    tm.handleTimerExpiration(t.id)
    expect(gpus.getGpu(g.id)!.last_active_at).not.toBeNull()
    expect(notifies[0]).toMatchObject({ title: 'Training Complete' })
  })

  it('审查重点#4：缺任务/缺行静默返回，不抛错', () => {
    expect(() => tm.handleTimerExpiration(999)).not.toThrow()
    const s = tasks.createTask('行被删', { skipDedup: true })
    tm.startWait(s.id, 60)
    db.run('DELETE FROM timers WHERE task_id = ?', [s.id])
    expect(() => tm.handleTimerExpiration(s.id)).not.toThrow()
    expect(notifies).toHaveLength(0)
  })
})
