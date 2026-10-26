/**
 * mdSync I/O 层：epochtodo.md 读写与任务绑定（md_file_path / md_line_hash）。
 * 对齐语义规格 §5.5（EpochToDo electron/mdSync/service.ts 行为）：
 * 导入（查重/force）、导出、merge 回写、三阶段双向同步、单任务增改删钩子、子树搬移。
 * 数据层经 TodoDB + TaskService 注入（测试用 tests/helpers/memdb.ts）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { TodoDB } from '../db'
import type { TaskRow, TaskStatus, TaskType } from '../../../shared/todo-types'
import { TaskService } from '../service'
import {
  hashContent,
  parseMdContent,
  buildBulletTree,
  generateMdFromTasks,
  computeTaskRepairs,
  planMdMerge,
  planSubtreeMove,
} from './pure'
import type { BulletNode, ParsedBullet, TaskConflict } from './pure'

export { hashContent, parseMdContent, generateMdFromTasks } from './pure'
export type { ParsedBullet, MdTask } from './pure'

/* ------------------------------------------------------------------ */
/* 结果类型                                                            */
/* ------------------------------------------------------------------ */

/** importFromMd 结果；duplicates 非空且未 force 时不写库 */
export interface ImportResult {
  created: number
  updated: number
  duplicates: string[]
}

export interface ExportResult {
  written: boolean
  bulletCount: number
}

export interface SyncResult {
  created: number
  updated: number
  deleted: number
  conflicts: TaskConflict[]
}

/* ------------------------------------------------------------------ */
/* 固定文件名                                                          */
/* ------------------------------------------------------------------ */

/** mdSync 固定文件名（外部协议兼容，不可改） */
export const EPOCHTODO_FILENAME = 'epochtodo.md'

/** 目录下 epochtodo.md 的完整路径 */
export function getEpochtodoPath(folderPath: string): string {
  return path.join(folderPath, EPOCHTODO_FILENAME)
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export class MdSyncService {
  private tasks: TaskService

  constructor(private db: TodoDB) {
    this.tasks = new TaskService(db)
  }

  /** DB→MD 写前预览（与 generateMdFromTasks 同规则的确定性字符串），用于跳过无变化写入。 */
  generatePreview(tasks: TaskRow[]): string {
    return generateMdFromTasks(tasks)
  }

  /**
   * 导入 MD → 任务树（standard/queued/绑定 hash、sort_order=lineIndex）。
   * 查重：bullet 标题（含 [x]）与既有 standard 任务精确同名 → 有重复且 !force 时
   * 不写库直接返回 duplicates。checked bullet 跳过但其子节点上提挂到同一 parent。
   * force 时先删 md_file_path=filePath 的所有任务再全量导入。
   */
  async importFromMd(filePath: string, force: boolean, rootParentId: number | null = null): Promise<ImportResult> {
    const content = await fsp.readFile(filePath, 'utf-8')
    const bullets = parseMdContent(content)
    const tree = buildBulletTree(bullets)

    const existingTitles = new Set(
      this.db.all<{ title: string }>("SELECT title FROM tasks WHERE type = 'standard'").map((r) => r.title),
    )
    const duplicates = bullets.map((b) => b.text).filter((t) => existingTitles.has(t))
    if (duplicates.length > 0 && !force) {
      return { created: 0, updated: 0, duplicates }
    }

    if (force) {
      const bound = this.db.all<{ id: number }>('SELECT id FROM tasks WHERE md_file_path = ?', [filePath])
      this.deleteTasks(bound.map((r) => r.id))
    }

    let created = 0
    const now = new Date().toISOString()

    const createFromBullet = (node: BulletNode, parentId: number | null): void => {
      // completed 行不导入；子节点上提挂到同一 parent
      if (node.bullet.checked) {
        for (const child of node.children) createFromBullet(child, parentId)
        return
      }
      const id = this.insertMdTask(node.bullet, parentId, filePath, now)
      created++
      for (const child of node.children) createFromBullet(child, id)
    }
    for (const root of tree) createFromBullet(root, rootParentId)

    return { created, updated: 0, duplicates: [] }
  }

  /**
   * 导出：generateMdFromTasks 整文件覆盖写，回填导出任务的 md_file_path（不写 hash）。
   */
  async exportToMd(filePath: string, tasks: TaskRow[]): Promise<ExportResult> {
    const mdContent = generateMdFromTasks(tasks)
    const bulletCount = (mdContent.match(/^\s*[-*+]\s/gm) || []).length
    await fsp.writeFile(filePath, mdContent, 'utf-8')
    for (const task of tasks) {
      if (task.type === 'standard' || task.type === undefined) {
        this.db.run('UPDATE tasks SET md_file_path = ? WHERE id = ?', [filePath, task.id])
      }
    }
    return { written: true, bulletCount }
  }

  /**
   * 合并回写：planMdMerge + 批量 rebind（md_file_path + md_line_hash）+ 覆盖写文件。
   * 保留已有 `[x]` 行与无法匹配的内容；archived 任务已在文件里的行改 `[x]`，不在的不写。
   */
  async mergeTasksToMd(filePath: string, tasks: TaskRow[]): Promise<ExportResult> {
    const standardTasks = tasks.filter((t) => (t.type === 'standard' || t.type === undefined) && t.title.trim() !== '')

    let content: string | null = null
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      // 文件不存在 → plan 里按全量生成
    }

    const plan = planMdMerge(content, standardTasks, filePath)
    for (const r of plan.rebind) {
      this.db.run('UPDATE tasks SET md_file_path = ?, md_line_hash = ? WHERE id = ?', [filePath, r.hash, r.id])
    }
    await fsp.writeFile(filePath, plan.newContent, 'utf-8')
    return { written: true, bulletCount: plan.bulletCount }
  }

  /**
   * 双向同步（§5.5 三阶段）：
   * 文件不存在 → 把绑定任务 exportToMd 后返回。
   * Phase 1（树递归）：checked 行——匹配到的非 archived 任务删除（已 archived 不动、
   *   不进 processed），不从 [x] 建任务，子节点上提挂同一 parent；未勾选——匹配到则
   *   computeTaskRepairs 修复（MD 获胜），未匹配则建任务（绑定 hash）。
   * Phase 2 删除：绑定本文件、标题非空白（草稿豁免）、未被处理、且 md_line_hash
   *   不在文件 hash 集合 → 删除（只删 hash 消失的）。
   * Phase 3：regenerateMd=true（手动同步）才 mergeTasksToMd 回写；
   *   watcher 路径传 false（MD→DB 单向，保护用户编辑）。
   */
  async syncWithMd(filePath: string, regenerateMd = true): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, deleted: 0, conflicts: [] }

    let mdContent: string
    try {
      mdContent = await fsp.readFile(filePath, 'utf-8')
    } catch {
      const boundTasks = this.db.all<TaskRow>('SELECT * FROM tasks WHERE md_file_path = ?', [filePath])
      if (boundTasks.length > 0) await this.exportToMd(filePath, boundTasks)
      return result
    }

    const bullets = parseMdContent(mdContent)
    const bulletTree = buildBulletTree(bullets)
    const bulletHashes = new Set(bullets.map((b) => b.hash))

    const dbTasks = this.db.all<TaskRow>('SELECT * FROM tasks WHERE md_file_path = ?', [filePath])
    const taskByHash = new Map<string, TaskRow>()
    for (const t of dbTasks) {
      if (t.md_line_hash) taskByHash.set(t.md_line_hash, t)
    }
    const activeFocusTaskIds = new Set(
      this.db.all<{ task_id: number }>("SELECT task_id FROM timers WHERE type = 'focus'").map((r) => r.task_id),
    )

    // Phase 1：MD→DB（匹配修复 / 建任务 / [x] 删任务）
    const processedTaskIds = new Set<number>()
    const now = new Date().toISOString()

    const syncBulletNode = (node: BulletNode, parentId: number | null): number | null => {
      const existing = taskByHash.get(node.bullet.hash)

      if (node.bullet.checked) {
        // 匹配到的活动任务视为用户在 MD 里完成 → 删除；已 archived 不动。
        // 永不从 [x] 建任务；子节点上提挂到同一 parent。
        if (existing && existing.status !== 'archived') {
          this.deleteTasks([existing.id])
          result.deleted++
        }
        for (const child of node.children) syncBulletNode(child, parentId)
        return null
      }

      if (existing) {
        const { updates, conflict } = computeTaskRepairs(existing, node.bullet.text, parentId, activeFocusTaskIds)
        if (conflict) result.conflicts.push(conflict)
        if (Object.keys(updates).length > 0) {
          this.tasks.updateTask(existing.id, updates)
          result.updated++
        }
        processedTaskIds.add(existing.id)
        for (const child of node.children) syncBulletNode(child, existing.id)
        return existing.id
      }

      const newId = this.insertMdTask(node.bullet, parentId, filePath, now)
      result.created++
      processedTaskIds.add(newId)
      for (const child of node.children) syncBulletNode(child, newId)
      return newId
    }
    for (const root of bulletTree) syncBulletNode(root, null)

    // Phase 2：只删"hash 消失"的绑定任务；空白标题=未保存草稿豁免
    for (const task of dbTasks) {
      if (task.title.trim() === '') continue
      if (processedTaskIds.has(task.id)) continue
      if (task.md_line_hash && !bulletHashes.has(task.md_line_hash)) {
        this.deleteTasks([task.id])
        result.deleted++
      }
    }

    // Phase 3：手动同步才回写（watcher 单向）
    if (regenerateMd) {
      await this.mergeTasksToMd(filePath, this.db.all<TaskRow>('SELECT * FROM tasks'))
    }

    return result
  }

  /**
   * 新任务写入 MD：有父且父有 hash → 插在父行紧后、缩进父 depth+1（注意与 merge 的
   * "子群末尾"不同）；否则追加末尾。回写 md_file_path + hashContent(title)。
   * 空白标题（未保存草稿）跳过。
   */
  async appendTaskToMd(filePath: string, task: TaskRow): Promise<void> {
    if (task.title.trim() === '') return

    let content = ''
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      // 文件不存在 → 按空文件创建
    }

    const lines = content.split(/\r?\n/)
    let insertIndex = lines.length
    let indent = ''

    if (task.parent_id) {
      const parentTask = this.tasks.getTask(task.parent_id)
      if (parentTask && parentTask.md_line_hash) {
        const parentBullet = parseMdContent(content).find((b) => b.hash === parentTask.md_line_hash)
        if (parentBullet) {
          insertIndex = parentBullet.lineIndex + 1
          indent = '  '.repeat(parentBullet.depth + 1)
        }
      }
    }

    lines.splice(insertIndex, 0, `${indent}- ${task.status === 'archived' ? '[x] ' : '[ ] '}${task.title}`)
    await fsp.writeFile(filePath, lines.join('\n'), 'utf-8')
    this.db.run('UPDATE tasks SET md_file_path = ?, md_line_hash = ? WHERE id = ?', [
      filePath,
      hashContent(task.title),
      task.id,
    ])
  }

  /**
   * 改名就地重写（防 merge 追加重复行 + watcher 复活旧标题）：按 md_line_hash 定位行，
   * 保留缩进与符号；check 前缀：newStatus='archived'→[x]、'active'→[ ]、否则保持原状态。
   * 回写 hash=hashContent(newTitle)（DB 标题由调用方随后更新）。
   */
  async updateTaskInMd(filePath: string, taskId: number, newTitle: string, newStatus?: TaskStatus): Promise<void> {
    let content: string
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      return
    }
    const task = this.tasks.getTask(taskId)
    if (!task || !task.md_line_hash) return

    const lines = content.split(/\r?\n/)
    const bullet = parseMdContent(content).find((b) => b.hash === task.md_line_hash)
    if (!bullet) return

    const checkPrefix =
      newStatus === 'archived' ? '[x] ' : newStatus === 'active' ? '[ ] ' : bullet.checked ? '[x] ' : '[ ] '
    const match = lines[bullet.lineIndex].match(/^(\s*)([-*+])\s/)
    const indent = match ? match[1] : ''
    const marker = match ? match[2] : '-'
    lines[bullet.lineIndex] = `${indent}${marker} ${checkPrefix}${newTitle}`
    await fsp.writeFile(filePath, lines.join('\n'), 'utf-8')
    this.db.run('UPDATE tasks SET md_line_hash = ? WHERE id = ?', [hashContent(newTitle), taskId])
  }

  /**
   * 删除任务对应的 MD 行：hash 定位，失败回退 hashContent(title) 定位；
   * splice 单行（不删子树，注记/子行保留）。
   */
  async removeTaskFromMd(filePath: string, taskId: number): Promise<void> {
    let content: string
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      return
    }
    const task = this.tasks.getTask(taskId)
    if (!task) return

    const lines = content.split(/\r?\n/)
    const bullets = parseMdContent(content)
    let bullet = task.md_line_hash ? bullets.find((b) => b.hash === task.md_line_hash) : undefined
    if (!bullet) bullet = bullets.find((b) => b.hash === hashContent(task.title))
    if (!bullet) return

    lines.splice(bullet.lineIndex, 1)
    await fsp.writeFile(filePath, lines.join('\n'), 'utf-8')
  }

  /**
   * 层级变更后搬移 MD 子树（手术式，含注记行）；文件不存在或无需移动则不写。
   * 缺此钩子时 watcher 的 MD→DB 合并会用旧缩进把 parent_id 修回去。
   */
  async moveTaskSubtreeInMd(filePath: string, taskId: number): Promise<void> {
    let content: string
    try {
      content = await fsp.readFile(filePath, 'utf-8')
    } catch {
      return // 文件还没有 —— export 会生成
    }
    const plan = planSubtreeMove(content, this.db.all<TaskRow>('SELECT * FROM tasks'), taskId)
    if (!plan || !plan.moved) return
    await fsp.writeFile(filePath, plan.newContent, 'utf-8')
  }

  /* -------------------------------------------------------------- */
  /* 内部工具                                                        */
  /* -------------------------------------------------------------- */

  /** 按 bullet 建任务（queued/standard/绑定 hash、sort_order=lineIndex），返回新 id */
  private insertMdTask(bullet: ParsedBullet, parentId: number | null, filePath: string, now: string): number {
    this.db.run(
      `INSERT INTO tasks (title, status, type, parent_id, sort_order, created_at, total_duration, is_next_action, md_file_path, md_line_hash)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      [bullet.text, 'queued', 'standard', parentId, bullet.lineIndex, now, filePath, bullet.hash],
    )
    return this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id
  }

  /** 删任务行（timer 行一并清理，防悬挂） */
  private deleteTasks(ids: number[]): void {
    if (ids.length === 0) return
    const marks = ids.map(() => '?').join(',')
    this.db.run(`DELETE FROM timers WHERE task_id IN (${marks})`, ids)
    this.db.run(`DELETE FROM tasks WHERE id IN (${marks})`, ids)
  }
}
