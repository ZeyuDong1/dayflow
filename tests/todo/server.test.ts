import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { TaskService } from '../../src/main/todo/service'
import { GpuService } from '../../src/main/todo/gpu-service'
import { TimerManager, type TimerEvent } from '../../src/main/todo/timer-manager'
import { AiReminderService, formatAiTaskTitle } from '../../src/main/todo/ai-reminder'
import { createTodoServer, type TodoServer } from '../../src/main/todo/server'
import { DEFAULT_TODO_SETTINGS } from '../../src/main/todo/settings'

const T0 = Date.parse('2026-01-01T12:00:00')

let db: MemDb
let tasks: TaskService
let gpus: GpuService
let tm: TimerManager
let ai: AiReminderService
let events: TimerEvent[]
let server: TodoServer
let port: number

beforeAll(async () => {
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
  ai = new AiReminderService({ db, tasks, broadcast: (e) => events.push(e as never), now: () => T0 })
  server = createTodoServer({
    tasks,
    gpus,
    timerManager: tm,
    ai,
    broadcast: (e) => events.push(e as never),
    now: () => T0,
    port: 0,
  })
  port = await server.start()
})

afterAll(async () => {
  await server.stop()
})

beforeEach(() => {
  tasks.deleteAllTasks()
  events.length = 0
  ai.feed.drain() // 清掉前序用例遗留的 aiFeed 卡片
})

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function postRawChunks(path: string, raw: string, splitAt: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(raw, 'utf8')
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.write(buf.subarray(0, splitAt))
    req.write(buf.subarray(splitAt))
    req.end()
  })
}

describe('POST /hook', () => {
  it('kind:"ai" → 200 {success:true}；缺 source/title → 400', async () => {
    const ok = await post('/hook', { kind: 'ai', source: 'Claude', title: 'done', status: 'progress' })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ success: true })
    const bad = await post('/hook', { kind: 'ai', title: 'x' })
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ error: 'ai reminder requires "source" and "title"' })
  })

  it('kind:"ai-dismiss" → 200 {success:true, dismissed_tasks}', async () => {
    await post('/hook', { kind: 'ai', source: 's', title: 't', status: 'success' })
    expect(tasks.getAllTasks().some((t) => t.title === formatAiTaskTitle('s', 't'))).toBe(true)
    const res = await post('/hook', { kind: 'ai-dismiss', source: 's', title: 't', force: true })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ success: true, dismissed_tasks: 1 })
    const bad = await post('/hook', { kind: 'ai-dismiss', force: true })
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ error: 'ai-dismiss requires "source" and/or "title"' })
  })

  it('训练更新启发式 → 200 / 404 Task not found', async () => {
    const ok = await post('/hook', { gpu_name: 'G1', title: '训练A', model_name: 'bert', eta: '2h' })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ success: true, message: 'Training status updated' })
    const missing = await post('/hook', { task_id: 9999 })
    expect(missing.status).toBe(404)
    expect(missing.json).toEqual({ error: 'Task not found' })
  })

  it('纯通知缺 title → 400 Title is required；有 title → 200 + 伪任务 timer:ended', async () => {
    const bad = await post('/hook', { message: 'hi' })
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ error: 'Title is required' })
    const ok = await post('/hook', { title: '构建完成', message: 'exit 0' })
    expect(ok.status).toBe(200)
    const ended = events.find((e) => e.type === 'timer:ended')!
    expect(ended.task).toMatchObject({ title: '构建完成', context_memo: 'exit 0', type: 'notification' })
  })

  it('审查重点#1：中文长 body 分块（切在多字节字符中间）仍正确解析', async () => {
    const raw = JSON.stringify({ kind: 'ai', source: '中文来源', title: '很长的中文标题'.repeat(30), status: 'info' })
    const splitAt = Buffer.from(raw, 'utf8').indexOf(Buffer.from('中', 'utf8')) + 1 // 切在"中"字中间
    const res = await postRawChunks('/hook', raw, splitAt)
    expect(res.status).toBe(200)
    const card = events.find((e) => e.type === 'ai:reminder')!
    expect(card.type === 'ai:reminder' && card.reminder.source).toBe('中文来源')
  })

  it('/hook 带 query → 404；未知路径 404；JSON 损坏 → 500', async () => {
    const q = await fetch(`http://127.0.0.1:${port}/hook?x=1`, { method: 'POST', body: '{}' })
    expect(q.status).toBe(404)
    const other = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(other.status).toBe(404)
    const broken = await post('/hook', '{bad json')
    expect(broken.status).toBe(500)
    expect(broken.json).toEqual({ error: 'Invalid JSON or Server Error' })
  })

  it('OPTIONS → 200 + CORS 头（Allow-Origin 字面量）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'OPTIONS' })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:*')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
  })
})

describe('桌宠桥 /bridge/*', () => {
  it('GET /bridge/state：focus/sideFocus/queued(≤20, bang 排序)/dueReminders(≤10)', async () => {
    const focused = tasks.createTask('专注中!')
    tm.startFocus(focused.id)
    const side = tasks.createTask('副焦点', { skipDedup: true })
    tasks.setSideFocus(side.id, true)
    const q1 = tasks.createTask('队列高!!', { skipDedup: true })
    tasks.createTask('队列低', { skipDedup: true })
    const due = tasks.createTask('过期软提醒', { type: 'reminder', skipDedup: true })
    tm.startWait(due.id, 60)
    // 手动把倒计时拨到过期
    db.run('UPDATE timers SET target_timestamp = ? WHERE task_id = ?', [new Date(T0 - 1000).toISOString(), due.id])

    const res = await fetch(`http://127.0.0.1:${port}/bridge/state`)
    const state = await res.json()
    expect(state.focus).toMatchObject({ id: focused.id, title: '专注中!' })
    expect(state.sideFocus.map((t: { id: number }) => t.id)).toContain(side.id)
    expect(state.queued[0].id).toBe(q1.id) // bang 排序
    expect(state.queued.length).toBeLessThanOrEqual(20)
    expect(state.dueReminders[0].id).toBe(due.id)
    expect(state.queued[0]).toMatchObject({ priority: 2 })
  })

  it('GET /bridge/reminders：drain 一次性领取不重复', async () => {
    await post('/hook', { kind: 'ai', source: 's', title: '卡1', status: 'info' })
    const r1 = await (await fetch(`http://127.0.0.1:${port}/bridge/reminders`)).json()
    expect(r1.reminders.map((r: { title: string }) => r.title)).toEqual(['卡1'])
    const r2 = await (await fetch(`http://127.0.0.1:${port}/bridge/reminders`)).json()
    expect(r2.reminders).toHaveLength(0)
  })

  it('POST /bridge/tasks：{created,task}，同名去重 created:false；title>200 → 400', async () => {
    const a = await post('/bridge/tasks', { title: '桥建任务', tag: 't' })
    expect(a.status).toBe(200)
    expect(a.json).toMatchObject({ created: true, task: { title: '桥建任务', is_next_action: 1 } })
    const b = await post('/bridge/tasks', { title: '桥建任务' })
    expect(b.json).toMatchObject({ created: false })
    const bad = await post('/bridge/tasks', { title: 'x'.repeat(201) })
    expect(bad.status).toBe(400)
  })
})
