import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import { GpuService } from '../../src/main/todo/gpu-service'
import { TimerManager } from '../../src/main/todo/timer-manager'
import { AiReminderService } from '../../src/main/todo/ai-reminder'
import { registerTodoIpc, startFocusWithRotation, type IpcRegistry, type TodoIpcDeps } from '../../src/main/todo/ipc-registry'
import { DEFAULT_TODO_SETTINGS, saveTodoSettings, type TodoSettings, type DeepPartial } from '../../src/main/todo/settings'

const T0 = Date.parse('2026-01-01T12:00:00')

let db: MemDb
let deps: TodoIpcDeps
let tm: TimerManager
let tasks: TaskService
let registry: IpcRegistry
let handlers: Map<string, (...args: unknown[]) => unknown>
let listeners: Map<string, (...args: unknown[]) => void>
let hidden: number

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  const gpus = new GpuService(db)
  tm = new TimerManager({
    db, tasks, gpus,
    getSettings: () => DEFAULT_TODO_SETTINGS,
    broadcast: () => {},
    now: () => T0,
    notify: () => {},
  })
  const ai = new AiReminderService({ db, tasks, broadcast: () => {}, now: () => T0 })
  let settings: TodoSettings = structuredClone(DEFAULT_TODO_SETTINGS)
  hidden = 0
  deps = {
    tasks, gpus, timerManager: tm, ai,
    getSettings: () => settings,
    saveSettings: (patch: DeepPartial<TodoSettings>) => saveTodoSettings(db, patch),
    hideReminder: () => hidden++,
  }
  handlers = new Map()
  listeners = new Map()
  registry = {
    handle: (ch, fn) => handlers.set(ch, fn as never),
    on: (ch, fn) => listeners.set(ch, fn as never),
  }
  registerTodoIpc(registry, deps)
})

const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!(null as never, ...(args as never[]))
const send = (ch: string, ...args: unknown[]) => listeners.get(ch)!(null as never, ...(args as never[]))

describe('registerTodoIpc', () => {
  it('注册域齐全（任务/计时/AI/GPU/Reminder/设置）', () => {
    for (const ch of [
      'todo:get-tasks', 'todo:create-task', 'todo:update-task', 'todo:set-side-focus',
      'todo:delete-task', 'todo:delete-all-tasks', 'todo:get-suggestions',
      'todo:start-training', 'todo:pause-training', 'todo:stop-training', 'todo:snooze',
      'todo:ai-promote', 'todo:get-gpus', 'todo:create-gpu', 'todo:delete-gpu',
      'todo:get-settings', 'todo:update-settings',
    ]) expect(handlers.has(ch), ch).toBe(true)
    for (const ch of [
      'todo:start-focus', 'todo:stop-focus', 'todo:complete-task', 'todo:start-wait',
      'todo:cancel-wait', 'todo:add-memo', 'todo:ai-dismiss', 'todo:assign-gpu',
      'todo:reminder-hide', 'todo:reminder-snooze',
    ]) expect(listeners.has(ch), ch).toBe(true)
  })

  it('handle 转发到 domain 方法并回传', async () => {
    const created = call('todo:create-task', '新任务', { tag: 'x' }) as { id: number }
    expect((call('todo:get-tasks') as unknown[]).length).toBe(1)
    call('todo:update-task', created.id, { title: '改名' })
    expect((call('todo:get-tasks') as { title: string }[])[0].title).toBe('改名')
    expect(call('todo:set-side-focus', created.id, true)).toBe(true)
    send('todo:add-memo', created.id, '备注')
    send('todo:start-wait', created.id, 60)
    call('todo:snooze', created.id, 5)
    call('todo:delete-task', created.id)
    expect(call('todo:get-tasks')).toHaveLength(0)
  })

  it('副焦点轮换：清目标 side 标志、旧 focus 降级为 side', () => {
    const a = tasks.createTask('A')
    const b = tasks.createTask('B', { skipDedup: true })
    const c = tasks.createTask('C', { skipDedup: true })
    send('todo:start-focus', a.id)
    tasks.setSideFocus(b.id, true)
    send('todo:start-focus', c.id)
    expect(tasks.getTask(c.id)!.status).toBe('active')
    expect(tasks.getTask(c.id)!.is_side_focus).toBe(0)
    expect(tasks.getTask(a.id)!.is_side_focus).toBe(1) // 旧焦点降级为副
    expect(tasks.getTask(b.id)!.is_side_focus).toBe(1)
  })

  it('副焦点轮换：满 2 个时旧焦点降级静默跳过', () => {
    const a = tasks.createTask('A')
    const b = tasks.createTask('B', { skipDedup: true })
    const d = tasks.createTask('D', { skipDedup: true })
    const c = tasks.createTask('C', { skipDedup: true })
    send('todo:start-focus', a.id)
    tasks.setSideFocus(b.id, true)
    tasks.setSideFocus(d.id, true)
    send('todo:start-focus', c.id)
    expect(tasks.getTask(a.id)!.is_side_focus).toBe(0) // 满员，静默跳过
  })

  it('complete-task 走 TimerManager（焦点移交+级联归档）', () => {
    const p = tasks.createTask('父')
    const c = tasks.createTask('子', { parentId: p.id, skipDedup: true })
    send('todo:start-focus', c.id)
    send('todo:complete-task', c.id)
    expect(tasks.getTask(c.id)!.status).toBe('archived')
    expect(tasks.getTask(p.id)!.status).toBe('active')
  })

  it('reminder 域：snooze 后隐藏窗口；ai-dismiss 转发删除', () => {
    const t = tasks.createTask('提醒', { type: 'reminder', skipDedup: true })
    send('todo:start-wait', t.id, 60)
    send('todo:reminder-snooze', t.id, 5)
    expect(hidden).toBe(1)
    const ai = deps.ai
    ai.handle({ source: 's', title: 't', status: 'success' })
    send('todo:ai-dismiss', { source: 's', title: 't' })
    expect(tasks.getAllTasks().some((x) => x.title.startsWith('🤖'))).toBe(false)
  })

  it('startFocusWithRotation 独立可用', () => {
    const a = tasks.createTask('A')
    startFocusWithRotation(deps, a.id)
    expect(tasks.getTask(a.id)!.status).toBe('active')
  })
})
