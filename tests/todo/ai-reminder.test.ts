import { describe, it, expect, beforeEach } from 'vitest'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import {
  normalizeAiReminder,
  createAiFeed,
  AiReminderService,
  formatAiTaskTitle,
  parseAiTaskTitle,
  type AiBroadcast,
} from '../../src/main/todo/ai-reminder'

const T0 = Date.parse('2026-01-01T12:00:00')

let db: MemDb
let tasks: TaskService
let events: AiBroadcast[]
let svc: AiReminderService

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  events = []
  svc = new AiReminderService({ db, tasks, broadcast: (e) => events.push(e), now: () => T0 })
})

describe('normalizeAiReminder', () => {
  it('source/title 必填（trim 后非空），否则抛错', () => {
    expect(() => normalizeAiReminder({ title: 'x' }, T0)).toThrow('ai reminder requires "source" and "title"')
    expect(() => normalizeAiReminder({ source: '  ', title: 'x' }, T0)).toThrow()
    expect(() => normalizeAiReminder({}, T0)).toThrow()
  })

  it('status 白名单外归 info', () => {
    expect(normalizeAiReminder({ source: 's', title: 't' }, T0).status).toBe('info')
    expect(normalizeAiReminder({ source: 's', title: 't', status: 'weird' }, T0).status).toBe('info')
    expect(normalizeAiReminder({ source: 's', title: 't', status: 'needs_input' }, T0).status).toBe('needs_input')
  })

  it('link 仅接受 string；detail 非 null 即 String()', () => {
    const r = normalizeAiReminder({ source: 's', title: 't', detail: 42, link: 7 }, T0)
    expect(r.detail).toBe('42')
    expect(r.link).toBeUndefined()
  })

  it('timestamp：>1e12 毫秒、≤1e12 秒×1000、缺失/非 number 用 now', () => {
    expect(normalizeAiReminder({ source: 's', title: 't', timestamp: 1.8e12 }, T0).timestamp).toBe(1.8e12)
    expect(normalizeAiReminder({ source: 's', title: 't', timestamp: 1718900000 }, T0).timestamp).toBe(1718900000000)
    expect(normalizeAiReminder({ source: 's', title: 't', timestamp: 'x' }, T0).timestamp).toBe(T0)
    expect(normalizeAiReminder({ source: 's', title: 't' }, T0).timestamp).toBe(T0)
  })
})

describe('AiFeed', () => {
  it('cap 头部裁剪；drain 只返回未播报的旧→新并置位', () => {
    const feed = createAiFeed(2)
    feed.push(normalizeAiReminder({ source: 'a', title: '1' }, T0))
    feed.push(normalizeAiReminder({ source: 'a', title: '2' }, T0))
    feed.push(normalizeAiReminder({ source: 'a', title: '3' }, T0)) // 裁掉 1
    const first = feed.drain()
    expect(first.map((r) => r.title)).toEqual(['2', '3'])
    expect(first[0].id).toBe('ai-2')
    expect(feed.drain()).toHaveLength(0) // 已领取不重复
    feed.push(normalizeAiReminder({ source: 'a', title: '4' }, T0))
    expect(feed.drain().map((r) => r.title)).toEqual(['4'])
  })
})

describe('AiReminderService.handle', () => {
  it('success/needs_input/review → 落库 🤖 任务 + 广播 timer:ended 与 fetch-tasks', () => {
    svc.handle({ source: 'Claude Code', title: '构建通过', status: 'success', detail: 'main #f3a1', link: 'https://x/1' })
    const row = tasks.getAllTasks().find((t) => t.title === formatAiTaskTitle('Claude Code', '构建通过'))!
    expect(row.type).toBe('notification')
    expect(row.context_memo).toBe('main #f3a1\nhttps://x/1')
    expect(events.some((e) => e.type === 'timer:ended' && e.taskId === row.id)).toBe(true)
    expect(events.some((e) => e.type === 'fetch-tasks')).toBe(true)
    expect(events.some((e) => e.type === 'ai:reminder')).toBe(false)
  })

  it('failure/progress/info → 只广播临时卡，不落库', () => {
    svc.handle({ source: 's', title: '失败了', status: 'failure' })
    expect(tasks.getAllTasks()).toHaveLength(0)
    const card = events.find((e) => e.type === 'ai:reminder')!
    expect(card.type === 'ai:reminder' && card.reminder.status).toBe('failure')
  })

  it('审查重点#3：硬提醒创建失败回退临时卡，不抛错', () => {
    const orig = tasks.createTask.bind(tasks)
    tasks.createTask = () => {
      throw new Error('db broken')
    }
    expect(() => svc.handle({ source: 's', title: '硬', status: 'review' })).not.toThrow()
    tasks.createTask = orig
    expect(events.some((e) => e.type === 'ai:reminder')).toBe(true)
  })

  it('无论软硬都进 aiFeed', () => {
    svc.handle({ source: 's', title: '软', status: 'info' })
    svc.handle({ source: 's', title: '硬', status: 'success' })
    expect(svc.feed.drain().map((r) => r.title)).toEqual(['软', '硬'])
  })
})

describe('promote', () => {
  it('建 reminder 任务 + 已过期 wait 行 + waiting 状态', () => {
    svc.handle({ source: 's', title: '待转', status: 'info' })
    const task = svc.promote('s', '待转', '详情', 'https://x')
    expect(task.type).toBe('reminder')
    expect(task.status).toBe('waiting')
    expect(task.context_memo).toBe('详情\nhttps://x')
    const row = db.get<{ target_timestamp: string; original_duration: number }>(
      'SELECT * FROM timers WHERE task_id = ?',
      [task.id],
    )!
    expect(Date.parse(row.target_timestamp)).toBe(T0 - 1000)
    expect(row.original_duration).toBe(0)
  })
})

describe('dismiss（审查重点#2）', () => {
  it('只删 🤖 前缀任务；首个 " · " 分隔；缺省=通配；递归删子树；用户任务不受影响', () => {
    const hard = svc.handle({ source: 'src', title: 'a · b', status: 'success' })
    expect(hard.status).toBe('success')
    const aiTask = tasks.getAllTasks().find((t) => t.title === formatAiTaskTitle('src', 'a · b'))!
    tasks.createTask('用户普通任务')
    tasks.createTask('用户子任务', { parentId: aiTask.id, skipDedup: true })

    expect(svc.dismiss({ source: 'src', title: 'a · b' })).toBe(1)
    expect(tasks.getAllTasks().some((t) => t.title === '用户普通任务')).toBe(true)
    expect(tasks.getAllTasks().some((t) => t.id === aiTask.id)).toBe(false)
    expect(tasks.getAllTasks().some((t) => t.title === '用户子任务')).toBe(false) // 子树递归删除

    // 通配：只给 source
    svc.handle({ source: 'src2', title: 'x', status: 'success' })
    svc.handle({ source: 'src2', title: 'y', status: 'success' })
    expect(svc.dismiss({ source: 'src2' })).toBe(2)
  })

  it('解析函数：标题内 " · " 不截断', () => {
    expect(parseAiTaskTitle(formatAiTaskTitle('s', 'a · b'))).toEqual({ source: 's', title: 'a · b' })
    expect(parseAiTaskTitle('普通任务')).toBeNull()
  })

  it('source/title 都缺 → 抛错', () => {
    expect(() => svc.dismiss({})).toThrow('ai-dismiss requires "source" and/or "title"')
  })

  it('广播 ai:reminder-dismissed {source,title,force,dismissed} + fetch-tasks', () => {
    svc.handle({ source: 's', title: 't', status: 'success' })
    svc.dismiss({ source: 's', title: 't', force: true })
    const evt = events.find((e) => e.type === 'ai:reminder-dismissed')!
    expect(evt).toMatchObject({ source: 's', title: 't', force: true, dismissed: 1 })
    expect(events.some((e) => e.type === 'fetch-tasks')).toBe(true)
  })
})
