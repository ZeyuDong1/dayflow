import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import { GpuService } from '../../src/main/todo/gpu-service'
import { TimerManager, type TimerEvent, type SyntheticTask, type TrainingStatusRecord } from '../../src/main/todo/timer-manager'
import { DEFAULT_TODO_SETTINGS, type TodoSettings } from '../../src/main/todo/settings'

// 用本地正午锚定，避开时区对静默时段判断的影响
const T0 = Date.parse('2026-01-01T12:00:00')

let db: MemDb
let tasks: TaskService
let gpus: GpuService
let tm: TimerManager
let events: TimerEvent[]
let settings: TodoSettings
let clock: number
let tick: (ms: number) => void
let setNow: (ms: number) => void

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  gpus = new GpuService(db)
  clock = T0
  events = []
  settings = structuredClone(DEFAULT_TODO_SETTINGS)
  tick = (ms) => (clock += ms)
  setNow = (ms) => (clock = ms)
  tm = new TimerManager({
    db,
    tasks,
    gpus,
    getSettings: () => settings,
    broadcast: (e) => events.push(e),
    now: () => clock,
    notify: () => {},
  })
})

function rec(taskId: number, lastUpdated: number, over: Partial<TrainingStatusRecord> = {}): TrainingStatusRecord {
  return {
    taskId,
    gpuName: 'A100',
    modelName: 'bert',
    lastUpdated,
    stalled: false,
    lastReminded: 0,
    source: 'webhook',
    ...over,
  }
}

describe('checkTaskNagging', () => {
  it('逾期分钟数为间隔整数倍时重放到期；不足一分钟不重放', () => {
    const s = tasks.createTask('nag', { skipDedup: true })
    tm.startWait(s.id, 60) // target = T0+60s
    setNow(T0 + 60_000 + 60_000) // 逾期 1 分钟
    tm.checkTaskNagging()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(0)
    setNow(T0 + 60_000 + 15 * 60_000) // 逾期 15 分钟
    tm.checkTaskNagging()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(1)
    setNow(T0 + 60_000 + 30 * 60_000) // 逾期 30 分钟
    tm.checkTaskNagging()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(2)
  })

  it('审查重点#3：间隔非法回退 15 分钟', () => {
    settings.reminder_nag_interval = 0
    const s = tasks.createTask('nag2', { skipDedup: true })
    tm.startWait(s.id, 60)
    setNow(T0 + 60_000 + 7 * 60_000) // 逾期 7 分钟：15 倍律不命中
    tm.checkTaskNagging()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(0)
    setNow(T0 + 60_000 + 15 * 60_000)
    tm.checkTaskNagging()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(1)
  })
})

describe('checkGpuHealth', () => {
  it('静默时段（默认 23→8）整体跳过，之外运行', () => {
    const t = tasks.createTask('s', { type: 'training', skipDedup: true })
    tm.upsertTrainingStatus(rec(t.id, T0 - 10 * 60_000))
    setNow(Date.parse('2026-01-01T23:30:00'))
    tm.checkGpuHealth()
    expect(events).toHaveLength(0)
    setNow(T0)
    tm.checkGpuHealth()
    expect(events.length).toBeGreaterThan(0)
  })

  it('停滞：首广播 stalled + 伪 ended；REMIND 间隔内不重发；到期重发；恢复解除', () => {
    const g = gpus.createGpu('A100')
    const t = tasks.createTask('训练停滞', { type: 'training', skipDedup: true })
    tm.startTraining(t.id, g.id, 3600)
    const base = rec(t.id, clock - 6 * 60_000) // 6 分钟无更新（>5 分钟阈值）
    tm.upsertTrainingStatus(base)

    tm.checkGpuHealth()
    expect(events.filter((e) => e.type === 'timer:training-update')).toHaveLength(1)
    const ended1 = events.find((e) => e.type === 'timer:ended')!
    expect((ended1.task as SyntheticTask).title).toBe('⚠️ 训练停滞: bert')
    expect((ended1.task as SyntheticTask).context_memo).toBe('webhook 来源 · 6 分钟无更新')

    events.length = 0
    tm.checkGpuHealth() // 10 分钟提醒间隔内不重发
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(0)

    tick(10 * 60_000)
    tm.checkGpuHealth()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(1)

    // 恢复更新
    tm.upsertTrainingStatus({ ...base, lastUpdated: clock })
    events.length = 0
    tm.checkGpuHealth()
    expect(events.filter((e) => e.type === 'timer:training-update')).toHaveLength(1) // 解除广播
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(0)
  })

  it('GPU 空闲告警：15 分钟节流；无空闲卡时节流归零可立即再报', () => {
    const g1 = gpus.createGpu('G1')
    const g2 = gpus.createGpu('G2')
    for (const name of ['q1', 'q2', 'q3']) tasks.createTask(name, { type: 'training', skipDedup: true })
    tm.checkGpuHealth()
    const ended = events.find((e) => e.type === 'timer:ended')!
    expect(ended.taskId).toBe(-1)
    expect((ended.task as SyntheticTask).title).toBe('GPU 空闲 · 2 个 GPU 上有 3 个训练任务排队')
    expect((ended.task as SyntheticTask).context_memo).toContain('q1、q2、q3')

    events.length = 0
    tm.checkGpuHealth() // 节流内不重发
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(0)

    // 两张卡都忙 → 无空闲 → 节流归零
    const t1 = tasks.createTask('w1', { type: 'training', skipDedup: true })
    const t2 = tasks.createTask('w2', { type: 'training', skipDedup: true })
    tm.startTraining(t1.id, g1.id, 3600)
    tm.startTraining(t2.id, g2.id, 3600)
    tm.checkGpuHealth()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(0)

    tm.pauseTraining(t1.id) // 释放一张 → 立即可报（无需等 15 分钟）
    tm.checkGpuHealth()
    expect(events.filter((e) => e.type === 'timer:ended')).toHaveLength(1)
  })

  it('已归档/缺失任务的遥测条目自动清理', () => {
    const t = tasks.createTask('gone', { type: 'training', skipDedup: true })
    tm.upsertTrainingStatus(rec(t.id, clock))
    tasks.updateTask(t.id, { status: 'archived' })
    tm.checkGpuHealth()
    expect(tm.trainingStatus.has(t.id)).toBe(false)
  })
})

describe('启动修复', () => {
  it('ensureGpuIdleState：idle GPU 缺 last_active_at 补 now', () => {
    const g = gpus.createGpu('G')
    db.run('UPDATE gpus SET last_active_at = NULL WHERE id = ?', [g.id])
    tm.ensureGpuIdleState()
    expect(gpus.getGpu(g.id)!.last_active_at).not.toBeNull()
  })

  it('reconcileStaleTraining：无遥测的 active 训练归档并释放 GPU；有遥测的保留', () => {
    const g = gpus.createGpu('A100')
    const zombie = tasks.createTask('zombie', { type: 'training', skipDedup: true })
    tm.startTraining(zombie.id, g.id, 3600)
    const alive = tasks.createTask('alive', { type: 'training', skipDedup: true })
    tasks.updateTask(alive.id, { status: 'active', gpu_id: g.id })
    tm.upsertTrainingStatus(rec(alive.id, clock))

    tm.reconcileStaleTraining()
    expect(tasks.getTask(zombie.id)!.status).toBe('archived')
    expect(tasks.getTask(zombie.id)!.gpu_id).toBeNull()
    expect(tasks.getTask(alive.id)!.status).toBe('active')
    expect(events.some((e) => e.type === 'fetch-tasks')).toBe(true)
  })
})
