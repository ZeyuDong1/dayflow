import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import { GpuService } from '../../src/main/todo/gpu-service'
import { TimerManager, type TimerEvent } from '../../src/main/todo/timer-manager'
import { DEFAULT_TODO_SETTINGS } from '../../src/main/todo/settings'

const T0 = Date.parse('2026-01-01T12:00:00')

let db: MemDb
let tasks: TaskService
let gpus: GpuService
let tm: TimerManager
let events: TimerEvent[]

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  gpus = new GpuService(db)
  events = []
  tm = new TimerManager({
    db,
    tasks,
    gpus,
    getSettings: () => DEFAULT_TODO_SETTINGS,
    broadcast: (e) => events.push(e),
    now: () => T0,
    notify: () => {},
  })
})

describe('updateTrainingStatus', () => {
  it('审查重点#5：任一 wandb 条目 → 整通道短路返回 true', () => {
    tm.upsertTrainingStatus({
      taskId: 1, gpuName: 'A100', lastUpdated: T0, stalled: false, lastReminded: 0, source: 'wandb',
    })
    expect(tm.updateTrainingStatus({ title: 'x', gpu_name: 'G' })).toBe(true)
    expect(tm.trainingStatus.size).toBe(1) // 未新增
  })

  it('task_id 直接解析；解析出的任务已有 wandb 条目则跳过', () => {
    const t = tasks.createTask('绑定任务', { type: 'training', skipDedup: true })
    expect(tm.updateTrainingStatus({ task_id: t.id, gpu_name: 'G1', metrics: { loss: 0.1 } })).toBe(true)
    expect(tm.trainingStatus.get(t.id)?.source).toBe('webhook')
    // 覆盖为 wandb 条目后 webhook 更新被跳过
    tm.upsertTrainingStatus({
      taskId: t.id, gpuName: 'G1', lastUpdated: T0, stalled: false, lastReminded: 0, source: 'wandb',
    })
    expect(tm.updateTrainingStatus({ task_id: t.id, gpu_name: 'G1', eta: '2h' })).toBe(true)
    expect(tm.trainingStatus.get(t.id)?.eta).toBeUndefined()
  })

  it('审查重点#4：GPU 上 active webhook 任务优先于任意 active；再精确标题；再模糊（带 gpu_name 严格校验）', () => {
    const g = gpus.createGpu('A100', { hostId: null })
    const wh = tasks.createTask('Training on A100', { type: 'training', is_webhook: 1, skipDedup: true })
    const other = tasks.createTask('手动训练', { type: 'training', skipDedup: true })
    tasks.updateTask(wh.id, { status: 'active', gpu_id: g.id })
    tasks.updateTask(other.id, { status: 'active', gpu_id: g.id })
    // ① GPU 上 active webhook 任务
    expect(tm.updateTrainingStatus({ gpu_name: 'A100', model_name: 'm1' })).toBe(true)
    expect(tm.trainingStatus.has(wh.id)).toBe(true)
    expect(tm.trainingStatus.has(other.id)).toBe(false)

    // ③ 精确标题（无 gpu 时）
    tm.trainingStatus.clear()
    const exact = tasks.createTask('精确名', { type: 'training', is_webhook: 1, skipDedup: true })
    tasks.updateTask(exact.id, { status: 'active' })
    expect(tm.updateTrainingStatus({ title: '精确名' })).toBe(true)
    expect(tm.trainingStatus.has(exact.id)).toBe(true)

    // ④ 模糊 + gpu_name 严格校验：无 gpu_id 的非 webhook 候选被拒
    tm.trainingStatus.clear()
    const loose = tasks.createTask('模糊候选', { type: 'training', skipDedup: true }) // 无 gpu、非 webhook
    expect(tm.updateTrainingStatus({ gpu_name: 'B200', title: '模糊候选' })).toBe(true)
    expect(tm.trainingStatus.has(loose.id)).toBe(false) // 未接管 → 自动建了新任务
  })

  it('全失败自动建任务（title||model_name||Training on {gpu}，active+is_webhook）；三者皆无 → false', () => {
    expect(tm.updateTrainingStatus({ gpu_name: 'G9' })).toBe(true)
    const created = tasks.getAllTasks().find((t) => t.title === 'Training on G9')!
    expect(created.status).toBe('active')
    expect(created.is_webhook).toBe(1)
    expect(tm.updateTrainingStatus({})).toBe(false)
  })

  it('GPU 处理：同卡 active 任务被接管（语义②）；其他非 webhook 绑定清除；host_id 回填；新卡 #4ade80', () => {
    const g = gpus.createGpu('X100')
    const adopted = tasks.createTask('手动占卡', { type: 'training', skipDedup: true })
    tasks.updateTask(adopted.id, { status: 'active', gpu_id: g.id })
    // ② 同 GPU 任意 active 被接管；host_id 回填到已有卡
    expect(tm.updateTrainingStatus({ gpu_name: 'X100', host_id: 'host-a', model_name: 'm' })).toBe(true)
    expect(gpus.getGpu(g.id)!.host_id).toBe('host-a')
    expect(tm.trainingStatus.get(adopted.id)).toMatchObject({ source: 'webhook', gpuName: 'X100' })

    // ① active webhook 任务优先；同卡其他非 webhook 任务绑定被清
    const wh = tasks.createTask('webhook 占卡', { type: 'training', is_webhook: 1, skipDedup: true })
    tasks.updateTask(wh.id, { status: 'active', gpu_id: g.id })
    tm.updateTrainingStatus({ gpu_name: 'X100', model_name: 'm2' })
    expect(tasks.getTask(adopted.id)!.gpu_id).toBeNull()
    expect(tasks.getTask(adopted.id)!.status).toBe('queued')
    expect(tasks.getTask(wh.id)!.gpu_id).toBe(g.id)

    // 全新 GPU 自动建卡
    tm.updateTrainingStatus({ gpu_name: 'NEW', title: 'n2' })
    const newGpu = gpus.findGpu('NEW')!
    expect(newGpu.color).toBe('#4ade80')
    expect(newGpu.host_id).toBeNull()
  })

  it('metrics.status==="completed" → 归档+GPU idle+清条目+📋 Check results 跟进任务', () => {
    const t = tasks.createTask('要完成的训练', { type: 'training', is_webhook: 1, skipDedup: true })
    tm.updateTrainingStatus({ task_id: t.id, gpu_name: 'G', metrics: { loss: 0.1 } })
    const gpuId = tasks.getTask(t.id)!.gpu_id
    expect(tm.updateTrainingStatus({ task_id: t.id, metrics: { status: 'completed' } })).toBe(true)
    expect(tasks.getTask(t.id)!.status).toBe('archived')
    expect(gpus.getGpu(gpuId!)!.last_active_at).not.toBeNull()
    expect(tm.trainingStatus.has(t.id)).toBe(false)
    expect(tasks.getAllTasks().some((x) => x.title === '📋 Check results: 要完成的训练')).toBe(true)
    expect(events.some((e) => e.type === 'fetch-tasks')).toBe(true)
  })

  it('非完成：写 TrainingStatus（source=webhook）并广播 timer:training-update', () => {
    tm.updateTrainingStatus({ gpu_name: 'G', title: 't', model_name: 'bert', eta: '2h 30m', metrics: { loss: 0.05 } })
    const rec = [...tm.trainingStatus.values()][0]
    expect(rec).toMatchObject({ modelName: 'bert', eta: '2h 30m', source: 'webhook', stalled: false })
    expect(events.some((e) => e.type === 'timer:training-update')).toBe(true)
  })
})
