/**
 * wandb 桥（语义规格 §9）：设置齐备才启动轮询（restart 语义）；
 * active run → GPU 卡/训练任务绑定 + trainingStatus(source='wandb')；
 * 正常 finished → 删卡+归档；crashed/killed → 不删卡不归档仅标停滞；
 * 每轮清理不在 active 集的 wandb 幽灵卡；启动 cleanupWandbGpus。
 */
import os from 'os'
import { createWandbClient } from './wandb/client'
import { WandbPoller, type ActiveRun, type FinishedRun } from './wandb/poller'
import type { TaskService } from './service'
import type { GpuService } from './gpu-service'
import type { TimerManager, TrainingStatusRecord } from './timer-manager'
import type { TodoSettings } from './settings'

const PALETTE = ['#4ade80', '#60a5fa', '#f472b6', '#facc15', '#a78bfa', '#34d399']

export interface WandbBridgeDeps {
  tasks: TaskService
  gpus: GpuService
  timerManager: TimerManager
  getSettings: () => TodoSettings
  broadcast: (event: unknown) => void
  now: () => number
}

export class WandbBridge {
  private poller: WandbPoller | null = null

  constructor(private deps: WandbBridgeDeps) {}

  /** 设置变化后调用：先停再按当前设置重启（key/entity 缺失即停）。 */
  update(): void {
    this.stop()
    const s = this.deps.getSettings()
    if (!s.wandb_api_key || !s.wandb_entity) return
    this.cleanupWandbGpus()
    const client = createWandbClient({ apiKey: s.wandb_api_key })
    this.poller = new WandbPoller({
      client,
      entity: s.wandb_entity,
      onPoll: (r) => void this.handlePoll(r),
    })
    this.poller.start()
  }

  stop(): void {
    this.poller?.stop()
    this.poller = null
  }

  private async handlePoll({ active, finished }: { active: ActiveRun[]; finished: FinishedRun[] }): Promise<void> {
    const seenGpuIds = new Set<number>()
    for (const { project, run } of active) {
      const hostId = `wandb:${project}:${run.id}`
      const gpu =
        this.deps.gpus.findGpu(run.name, hostId) ?? this.deps.gpus.findGpu(run.name) ?? this.deps.gpus.createGpu(run.name, {
          hostId,
          color: PALETTE[Math.abs(hashStr(hostId)) % PALETTE.length],
        })
      const task =
        this.deps.tasks
          .getAllTasks()
          .find((t) => t.title === run.name && t.type === 'training' && t.status !== 'archived') ??
        this.deps.tasks.createTask(run.name, { type: 'training', skipDedup: true, is_webhook: 1 })
      this.deps.tasks.updateTask(task.id, { gpu_id: gpu.id, status: 'active' })
      this.deps.gpus.setGpuBusy(gpu.id)
      seenGpuIds.add(gpu.id)
      const rec: TrainingStatusRecord = {
        taskId: task.id,
        gpuName: run.name,
        modelName:
          (typeof run.summaryMetrics['cfgname'] === 'string' && (run.summaryMetrics['cfgname'] as string)) || run.name,
        metrics: { ...run.summaryMetrics, wandbUrl: run.url },
        lastUpdated: this.deps.now(),
        stalled: false,
        lastReminded: 0,
        source: 'wandb',
        wandbUrl: run.url,
      }
      this.deps.timerManager.upsertTrainingStatus(rec)
      this.deps.broadcast({ type: 'timer:training-update', status: rec })
    }

    for (const { run, state } of finished) {
      const task = this.deps.tasks
        .getAllTasks()
        .find((t) => t.title === run.name && t.type === 'training' && t.status !== 'archived')
      if (state === 'crashed' || state === 'killed') {
        // 不删卡不归档：标停滞走 nag 流程
        if (task) {
          const rec = this.deps.timerManager.trainingStatus.get(task.id)
          if (rec) {
            rec.stalled = true
            this.deps.broadcast({ type: 'timer:training-update', status: rec })
          }
        }
        continue
      }
      // 正常结束：归档任务 + 删卡 + 清条目
      if (task) {
        this.deps.tasks.updateTask(task.id, { status: 'archived' })
        this.deps.timerManager.removeTrainingStatus(task.id)
      }
      const gpu = this.deps.gpus.findGpu(run.name)
      if (gpu && gpu.host_id?.startsWith('wandb:')) this.deps.gpus.deleteGpu(gpu.id)
    }

    // 幽灵卡清理：本轮不在 active 集的 wandb 卡删除（finished 已在上面删过）
    for (const g of this.deps.gpus.getAllGpus()) {
      if (g.host_id?.startsWith('wandb:') && !seenGpuIds.has(g.id)) {
        this.deps.gpus.deleteGpu(g.id)
      }
    }
    this.deps.broadcast({ type: 'fetch-tasks' })
  }

  /** 启动清理（语义规格 §1.5）：全部 wandb 卡 + 'Training on %' webhook 任务。 */
  cleanupWandbGpus(): void {
    for (const g of this.deps.gpus.getAllGpus()) {
      if (g.host_id?.startsWith('wandb:')) this.deps.gpus.deleteGpu(g.id)
    }
    for (const t of this.deps.tasks.getAllTasks()) {
      if (t.is_webhook === 1 && t.title.startsWith('Training on ')) this.deps.tasks.deleteTask(t.id)
    }
  }

  async testConnection(entity: string, apiKey: string): Promise<{ valid: boolean; projectCount: number; hostname: string; error?: string }> {
    try {
      const client = createWandbClient({ apiKey })
      const projects = await client.getRecentProjects(entity, 5)
      return { valid: true, projectCount: projects.length, hostname: os.hostname() }
    } catch (e) {
      return { valid: false, projectCount: 0, hostname: '', error: (e as Error).message }
    }
  }
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
