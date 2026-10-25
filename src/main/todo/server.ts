/**
 * 62222 webhook 服务器与桌宠桥（语义规格 §7，协议逐字节兼容）。
 * node:http 零依赖；body 先拼 Buffer 再 UTF-8 解码（防多字节跨包乱码）；
 * /hook 精确匹配 req.url（带 query 即 404）。
 */
import http from 'node:http'
import type { TaskService } from './service'
import type { GpuService } from './gpu-service'
import type { TimerManager, TrainingUpdateInput, SyntheticTask } from './timer-manager'
import type { AiReminderService } from './ai-reminder'
import { computeBangPriorities } from './priority'
import type { TaskRow } from '../../shared/todo-types'

export interface TodoServerDeps {
  tasks: TaskService
  gpus: GpuService
  timerManager: TimerManager
  ai: AiReminderService
  broadcast: (event: unknown) => void
  now: () => number
  port?: number
}

export interface TodoServer {
  start(): Promise<number>
  stop(): Promise<void>
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'http://localhost:*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS })
  res.end(text)
}

function empty404(res: http.ServerResponse): void {
  res.writeHead(404, CORS_HEADERS)
  res.end()
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))) // 整包解码
    req.on('error', reject)
  })
}

/** /bridge/state 的任务形状 */
function bridgeTaskShape(t: TaskRow, priority: number) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    type: t.type,
    priority,
    tag: t.tag,
    parentId: t.parent_id,
    startedAt: t.started_at ?? null,
    targetTimestamp: t.target_timestamp ?? null,
  }
}

export function createTodoServer(deps: TodoServerDeps): TodoServer {
  let server: http.Server | null = null

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(200, CORS_HEADERS)
        res.end()
        return
      }
      const url = req.url ?? ''
      const pathname = url.split('?')[0]

      if (req.method === 'GET' && pathname === '/bridge/state') {
        const tasks = deps.tasks.getAllTasks()
        const prio = computeBangPriorities(tasks.map((t) => ({ id: t.id, title: t.title, parent_id: t.parent_id })))
        const focus =
          tasks.find((t) => t.status === 'active' && t.type === 'standard') ??
          tasks.find((t) => t.status === 'active' && t.timer_type === 'focus') ??
          null
        const sideFocus = tasks.filter((t) => t.is_side_focus === 1 && t.status !== 'archived' && t.id !== focus?.id)
        const queued = tasks
          .filter((t) => t.status === 'queued' && t.is_next_action === 1)
          .sort((a, b) => (prio.get(b.id) ?? 0) - (prio.get(a.id) ?? 0))
          .slice(0, 20)
        const dueReminders = tasks
          .filter(
            (t) =>
              t.type === 'reminder' &&
              t.status === 'waiting' &&
              t.target_timestamp != null &&
              Date.parse(t.target_timestamp) <= deps.now(),
          )
          .sort((a, b) => Date.parse(a.target_timestamp!) - Date.parse(b.target_timestamp!))
          .slice(0, 10)
        json(res, 200, {
          ts: deps.now(),
          focus: focus ? bridgeTaskShape(focus, prio.get(focus.id) ?? 0) : null,
          sideFocus: sideFocus.map((t) => bridgeTaskShape(t, prio.get(t.id) ?? 0)),
          queued: queued.map((t) => bridgeTaskShape(t, prio.get(t.id) ?? 0)),
          dueReminders: dueReminders.map((t) => bridgeTaskShape(t, prio.get(t.id) ?? 0)),
        })
        return
      }

      if (req.method === 'GET' && pathname === '/bridge/reminders') {
        json(res, 200, { reminders: deps.ai.feed.drain() })
        return
      }

      if (req.method === 'POST' && pathname === '/bridge/tasks') {
        const text = await readBody(req)
        let data: Record<string, unknown>
        try {
          data = JSON.parse(text)
        } catch {
          json(res, 500, { error: 'Invalid JSON or Server Error' })
          return
        }
        const title = typeof data.title === 'string' ? data.title.trim() : ''
        const tag = typeof data.tag === 'string' ? data.tag : undefined
        if (!title || title.length > 200 || (tag != null && tag.length > 50)) {
          json(res, 400, { error: 'title (≤200) required; tag ≤50' })
          return
        }
        const existing = deps.tasks.getAllTasks().find((t) => t.title === title && t.status !== 'archived')
        if (existing) {
          json(res, 200, { created: false, task: existing })
          return
        }
        const task = deps.tasks.createTask(title, { tag, is_next_action: 1 })
        deps.broadcast({ type: 'fetch-tasks' })
        json(res, 200, { created: true, task })
        return
      }

      // /hook：精确匹配 req.url（带 query 会 404）
      if (req.method === 'POST' && url === '/hook') {
        const text = await readBody(req)
        let data: Record<string, unknown>
        try {
          data = JSON.parse(text)
        } catch {
          json(res, 500, { error: 'Invalid JSON or Server Error' })
          return
        }

        if (data.kind === 'ai') {
          try {
            deps.ai.handle(data)
            json(res, 200, { success: true })
          } catch (e) {
            json(res, 400, { error: (e as Error).message })
          }
          return
        }

        if (data.kind === 'ai-dismiss') {
          try {
            const dismissed = deps.ai.dismiss({
              source: typeof data.source === 'string' ? data.source : undefined,
              title: typeof data.title === 'string' ? data.title : undefined,
              force: data.force === true,
            })
            json(res, 200, { success: true, dismissed_tasks: dismissed })
          } catch (e) {
            json(res, 400, { error: (e as Error).message })
          }
          return
        }

        // 训练更新判定启发式
        const isTrainingUpdate =
          data.model_name != null ||
          data.gpu_name != null ||
          data.eta != null ||
          data.metrics != null ||
          (data.task_id != null && data.message == null)
        if (isTrainingUpdate) {
          const ok = deps.timerManager.updateTrainingStatus(data as TrainingUpdateInput)
          if (ok) {
            deps.broadcast({ type: 'fetch-tasks' })
            json(res, 200, { success: true, message: 'Training status updated' })
          } else {
            json(res, 404, { error: 'Task not found' })
          }
          return
        }

        // 纯通知
        if (typeof data.title !== 'string' || !data.title) {
          json(res, 400, { error: 'Title is required' })
          return
        }
        const pseudo: SyntheticTask & Partial<TaskRow> = {
          id: -1 * Date.now(),
          title: data.title,
          context_memo: data.message != null ? String(data.message) : null,
          type: 'notification',
        }
        deps.broadcast({ type: 'timer:ended', taskId: pseudo.id, task: pseudo as never })
        json(res, 200, { success: true })
        return
      }

      empty404(res)
    } catch (e) {
      json(res, 500, { error: (e as Error).message || 'Invalid JSON or Server Error' })
    }
  }

  return {
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          void handler(req, res)
        })
        server.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EADDRINUSE') {
            console.error('[todo-server] 端口 62222 被占用（另一实例？），AI 提醒将收不到')
            reject(e)
          } else {
            reject(e)
          }
        })
        server.listen(deps.port ?? 62222, '0.0.0.0', () => {
          const addr = server!.address()
          resolve(typeof addr === 'object' && addr ? addr.port : (deps.port ?? 62222))
        })
      })
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) return resolve()
        server.close(() => resolve())
        server = null
      })
    },
  }
}
