/**
 * GPU 卡服务（语义规格 §1.5）：忙闲状态用 last_active_at 表达（null=busy）。
 * wandb/webhook 的自动建卡在 P4；此处只做数据层。
 */
import type { TodoDB } from './db'
import type { GpuRow } from '../../shared/todo-types'

export type GpuWithActive = GpuRow & { activeTaskId: number | null }

export class GpuService {
  constructor(private db: TodoDB) {}

  createGpu(name: string, opts: { hostId?: string | null; color?: string | null } = {}): GpuRow {
    const now = new Date().toISOString()
    this.db.run('INSERT INTO gpus (name, host_id, color, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)', [
      name,
      opts.hostId ?? null,
      opts.color ?? null,
      now,
      now,
    ])
    return this.db.get<GpuRow>('SELECT * FROM gpus WHERE created_at = ? AND name = ? ORDER BY id DESC LIMIT 1', [
      now,
      name,
    ])!
  }

  findGpu(name: string, hostId?: string | null): GpuRow | undefined {
    if (hostId !== undefined) {
      return this.db.get<GpuRow>('SELECT * FROM gpus WHERE name = ? AND host_id IS ?', [name, hostId])
    }
    return this.db.get<GpuRow>('SELECT * FROM gpus WHERE name = ? LIMIT 1', [name])
  }

  getGpu(id: number): GpuRow | undefined {
    return this.db.get<GpuRow>('SELECT * FROM gpus WHERE id = ?', [id])
  }

  /** 派生 activeTaskId（active 且 type=training 且 gpu_id 匹配）。 */
  getAllGpus(): GpuWithActive[] {
    const rows = this.db.all<GpuRow>('SELECT * FROM gpus ORDER BY id ASC')
    return rows.map((g) => {
      const active = this.db.get<{ id: number }>(
        "SELECT id FROM tasks WHERE status = 'active' AND type = 'training' AND gpu_id = ? LIMIT 1",
        [g.id],
      )
      return { ...g, activeTaskId: active?.id ?? null }
    })
  }

  setGpuBusy(id: number): void {
    this.db.run('UPDATE gpus SET last_active_at = NULL WHERE id = ?', [id])
  }

  setGpuIdle(id: number): void {
    this.db.run('UPDATE gpus SET last_active_at = ? WHERE id = ?', [new Date().toISOString(), id])
  }

  /** 删 GPU：先删其上 is_webhook=1 的任务 → 非 webhook active 解绑回队列 → 删卡。 */
  deleteGpu(id: number): void {
    const webhookTasks = this.db.all<{ id: number }>('SELECT id FROM tasks WHERE gpu_id = ? AND is_webhook = 1', [id])
    for (const t of webhookTasks) this.db.run('DELETE FROM tasks WHERE id = ?', [t.id])
    this.db.run(
      `UPDATE tasks SET gpu_id = NULL, status = 'queued' WHERE gpu_id = ? AND status = 'active' AND is_webhook = 0`,
      [id],
    )
    this.db.run('DELETE FROM gpus WHERE id = ?', [id])
  }
}
