/**
 * WandbPoller（语义规格 §9）：默认 30s 轮询、start 立即一次、防重入、
 * trackedRuns 消失的 run 查最终态——null（瞬时错误）继续跟踪不判 finished。
 */
import type { WandbClient, WandbRun } from './client'

export interface ActiveRun {
  project: string
  run: WandbRun
}

export interface FinishedRun {
  project: string
  run: WandbRun
  state: string
}

export interface WandbPollerDeps {
  client: WandbClient
  entity: string
  maxProjects?: number
  intervalMs?: number
  onPoll: (r: { active: ActiveRun[]; finished: FinishedRun[] }) => void
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (h: unknown) => void
}

export class WandbPoller {
  private timer: unknown = null
  private polling = false
  private stopped = false
  readonly trackedRuns = new Map<string, { project: string; run: WandbRun }>()

  private readonly intervalMs: number
  private readonly st: (fn: () => void, ms: number) => unknown
  private readonly ct: (h: unknown) => void

  constructor(private deps: WandbPollerDeps) {
    this.intervalMs = deps.intervalMs ?? 30_000
    this.st = deps.setTimeoutFn ?? setTimeout
    this.ct = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as never))
  }

  start(): void {
    this.stop()
    this.stopped = false
    void this.poll() // 立即一次
  }

  stop(): void {
    this.stopped = true
    if (this.timer != null) {
      this.ct(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    if (this.timer != null) this.ct(this.timer)
    this.timer = this.st(() => void this.poll(), this.intervalMs)
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      const maxProjects = this.deps.maxProjects ?? 5
      const projects = await this.deps.client.getRecentProjects(this.deps.entity, maxProjects)
      const seen = new Set<string>()
      const active: ActiveRun[] = []
      for (const project of projects) {
        const runs = await this.deps.client.getRunningRuns(this.deps.entity, project)
        for (const run of runs) {
          seen.add(run.id)
          this.trackedRuns.set(run.id, { project, run })
          active.push({ project, run })
        }
      }
      const finished: FinishedRun[] = []
      for (const [id, tr] of [...this.trackedRuns]) {
        if (seen.has(id)) continue
        const state = await this.deps.client.getRunState(this.deps.entity, tr.project, id)
        if (state == null) continue // 瞬时错误：继续跟踪不误归档
        finished.push({ ...tr, state })
        this.trackedRuns.delete(id)
      }
      if (active.length > 0 || finished.length > 0) {
        this.deps.onPoll({ active, finished })
      }
    } catch {
      // 网络/接口错误：跳过本轮
    } finally {
      this.polling = false
      this.scheduleNext()
    }
  }
}
