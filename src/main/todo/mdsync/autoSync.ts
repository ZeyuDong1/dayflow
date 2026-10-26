/**
 * AutoSyncManager（语义规格 §5.6）：目录级 watcher（抗 Windows 原子保存）+ mtime 轮询兜底，
 * 双向防抖与自身写文件抑制窗。所有时长可注入便于测试。
 */
import fs from 'fs'
import path from 'path'
import { MdSyncService, getEpochtodoPath } from './service'
import type { TodoDB } from '../db'
import type { TaskService } from '../service'

export const FILE_DEBOUNCE_MS = 2000
export const TASK_DEBOUNCE_MS = 500
export const SUPPRESS_DELAY_MS = 1500
export const POLL_MS = 3000

export interface AutoSyncDeps {
  db: TodoDB
  tasks: TaskService
  broadcast: (event: unknown) => void
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  fileDebounceMs?: number
  taskDebounceMs?: number
  suppressDelayMs?: number
  pollMs?: number
}

export class AutoSyncManager {
  private svc: MdSyncService
  private filePath = ''
  private watcher: fs.FSWatcher | null = null
  private pollTimer: unknown = null
  private lastPollMtime = 0
  private fileDebounceTimer: unknown = null
  private taskDebounceTimer: unknown = null
  private suppressWatch = false
  private suppressLiftTimer: unknown = null
  private exportInProgress = false
  private lastWrittenContent = ''
  private started = false
  /** 最近一次成功同步的毫秒时间戳（get-status 用） */
  lastSyncTime = 0

  private readonly fileDebounceMs: number
  private readonly taskDebounceMs: number
  private readonly suppressDelayMs: number
  private readonly pollMs: number
  private readonly st: (fn: () => void, ms: number) => unknown
  private readonly ct: (h: unknown) => void

  constructor(private deps: AutoSyncDeps) {
    this.svc = new MdSyncService(deps.db)
    this.fileDebounceMs = deps.fileDebounceMs ?? FILE_DEBOUNCE_MS
    this.taskDebounceMs = deps.taskDebounceMs ?? TASK_DEBOUNCE_MS
    this.suppressDelayMs = deps.suppressDelayMs ?? SUPPRESS_DELAY_MS
    this.pollMs = deps.pollMs ?? POLL_MS
    this.st = deps.setTimeoutFn ?? setTimeout
    this.ct = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as never))
  }

  get isEnabled(): boolean {
    return this.started
  }

  get currentPath(): string {
    return this.filePath
  }

  start(folder: string): void {
    this.stop()
    this.filePath = getEpochtodoPath(folder)
    this.started = true
    this.lastPollMtime = 0
    // initialSync：文件在 → MD→DB；不在 → DB→MD 生成
    if (fs.existsSync(this.filePath)) {
      void this.syncFromFile()
    } else {
      void this.exportTasks()
    }
    this.startWatcher()
    this.startPolling()
  }

  stop(): void {
    this.started = false
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.pollTimer != null) {
      this.ct(this.pollTimer)
      this.pollTimer = null
    }
    if (this.fileDebounceTimer != null) {
      this.ct(this.fileDebounceTimer)
      this.fileDebounceTimer = null
    }
    if (this.taskDebounceTimer != null) {
      this.ct(this.taskDebounceTimer)
      this.taskDebounceTimer = null
    }
    if (this.suppressLiftTimer != null) {
      this.ct(this.suppressLiftTimer)
      this.suppressLiftTimer = null
    }
    this.suppressWatch = false
  }

  private startWatcher(): void {
    const folder = path.dirname(this.filePath)
    try {
      this.watcher = fs.watch(folder, (filename) => {
        if (filename === path.basename(this.filePath)) {
          this.debouncedSyncFromFile()
        }
      })
      this.watcher.on('error', () => {
        // watcher 失败 2s 重试（目录暂时不可用等）
        if (this.watcher) {
          this.watcher.close()
          this.watcher = null
        }
        if (this.started) {
          this.st(() => this.startWatcher(), 2000)
        }
      })
    } catch {
      if (this.started) this.st(() => this.startWatcher(), 2000)
    }
  }

  private startPolling(): void {
    this.pollTimer = this.st(() => {
      if (!this.started) return
      try {
        if (fs.existsSync(this.filePath)) {
          const mtime = fs.statSync(this.filePath).mtimeMs
          if (this.lastPollMtime !== 0 && mtime !== this.lastPollMtime) {
            this.debouncedSyncFromFile()
          }
          this.lastPollMtime = mtime // 首次观察只记录不触发
        }
      } catch {
        // 文件暂时不可读，下轮再试
      }
      this.startPolling()
    }, this.pollMs)
  }

  /** 文件侧 2s 防抖；抑制窗内到期不丢弃，以 500ms 重排直到解除。 */
  debouncedSyncFromFile(): void {
    if (this.fileDebounceTimer != null) this.ct(this.fileDebounceTimer)
    this.fileDebounceTimer = this.st(() => {
      this.fileDebounceTimer = null
      if (this.suppressWatch) {
        this.fileDebounceTimer = this.st(() => this.debouncedSyncFromFile(), 500)
        return
      }
      void this.syncFromFile()
    }, this.fileDebounceMs)
  }

  /** MD→DB 单向（不回写），完成后广播刷新；写后 1.5s 抑制窗。 */
  async syncFromFile(): Promise<void> {
    if (!this.started || this.suppressWatch) return
    this.suppressWatch = true
    try {
      await this.svc.syncWithMd(this.filePath, false)
      this.lastSyncTime = Date.now()
      this.deps.broadcast({ type: 'fetch-tasks' })
    } catch {
      // 文件损坏/占用：跳过本轮
    } finally {
      if (this.suppressLiftTimer != null) this.ct(this.suppressLiftTimer)
      this.suppressLiftTimer = this.st(() => {
        this.suppressWatch = false
        this.suppressLiftTimer = null
      }, this.suppressDelayMs)
    }
  }

  /** 任务变更后触发 DB→MD 导出（0.5s 防抖）。 */
  triggerExport(): void {
    if (!this.started) return
    if (this.taskDebounceTimer != null) this.ct(this.taskDebounceTimer)
    this.taskDebounceTimer = this.st(() => {
      this.taskDebounceTimer = null
      void this.exportTasks()
    }, this.taskDebounceMs)
  }

  /** DB→MD：并发锁 + 内容预览比对跳写；写后抑制窗。 */
  async exportTasks(): Promise<void> {
    if (!this.started) return
    if (this.exportInProgress) {
      this.st(() => void this.exportTasks(), 300)
      return
    }
    this.exportInProgress = true
    try {
      const preview = this.svc.generatePreview(this.deps.tasks.getAllTasks())
      if (preview === this.lastWrittenContent) return
      this.suppressWatch = true
      await this.svc.mergeTasksToMd(this.filePath, this.deps.tasks.getAllTasks())
      if (fs.existsSync(this.filePath)) {
        this.lastWrittenContent = fs.readFileSync(this.filePath, 'utf-8')
        this.lastSyncTime = Date.now()
      }
    } catch {
      // 写失败下一轮重试
    } finally {
      this.exportInProgress = false
      if (this.suppressLiftTimer != null) this.ct(this.suppressLiftTimer)
      this.suppressLiftTimer = this.st(() => {
        this.suppressWatch = false
        this.suppressLiftTimer = null
      }, this.suppressDelayMs)
    }
  }
}
