import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createMemDb, type MemDb } from '../helpers/memdb'
import { MdSyncService, getEpochtodoPath, hashContent } from '../../src/main/todo/mdsync/service'
import { TaskService } from '../../src/main/todo/service'
import type { TaskRow } from '../../src/shared/todo-types'

let db: MemDb
let tasks: TaskService
let svc: MdSyncService
let dir: string
let fp: string

beforeEach(async () => {
  db = await createMemDb()
  tasks = new TaskService(db)
  svc = new MdSyncService(db)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdsync-'))
  fp = getEpochtodoPath(dir)
})

const H = (t: string) => hashContent(t)

async function mkTask(title: string, over: Partial<TaskRow> = {}): Promise<TaskRow> {
  const t = tasks.createTask(title, { skipDedup: true })
  if (Object.keys(over).length > 0) tasks.updateTask(t.id, over)
  return tasks.getTask(t.id)!
}

describe('importFromMd', () => {
  it('bullet → 任务（queued/standard、绑定 hash、sort_order=lineIndex）', async () => {
    fs.writeFileSync(fp, '- [ ] 甲\n  - [ ] 乙\n')
    const r = await svc.importFromMd(fp, false)
    expect(r.created).toBe(2)
    const all = tasks.getAllTasks()
    const jia = all.find((t) => t.title === '甲')!
    const yi = all.find((t) => t.title === '乙')!
    expect(jia.status).toBe('queued')
    expect(jia.md_file_path).toBe(fp)
    expect(jia.md_line_hash).toBe(H('甲'))
    expect(yi.parent_id).toBe(jia.id)
    expect(yi.sort_order).toBe(1) // lineIndex
  })

  it('同名查重：未 force 不写库返回 duplicates；force 先清绑定任务再导', async () => {
    await mkTask('已存在')
    fs.writeFileSync(fp, '- [ ] 已存在\n- [ ] 新的\n')
    const r1 = await svc.importFromMd(fp, false)
    expect(r1.created).toBe(0)
    expect(r1.duplicates).toContain('已存在')
    expect(tasks.getAllTasks().some((t) => t.title === '新的')).toBe(false)
    const r2 = await svc.importFromMd(fp, true)
    expect(r2.created).toBe(2) // force：旧绑定任务被清后全量导入
  })

  it('checked bullet 跳过但子级上提挂到同一 parent', async () => {
    fs.writeFileSync(fp, '- [x] 已勾\n  - [ ] 幸存子\n')
    const r = await svc.importFromMd(fp, false)
    expect(r.created).toBe(1)
    const child = tasks.getAllTasks().find((t) => t.title === '幸存子')!
    expect(child.parent_id).toBeNull() // 上提为根
  })
})

describe('syncWithMd（双向核心）', () => {
  it('勾选 [x] 删除活动任务；archived 不动；改名 MD 获胜；新行建任务', async () => {
    const a = await mkTask('要删', { md_file_path: fp, md_line_hash: H('要删') })
    const b = await mkTask('已归档', { status: 'archived', md_file_path: fp, md_line_hash: H('已归档') })
    await mkTask('旧名', { md_file_path: fp, md_line_hash: H('旧名') })
    fs.writeFileSync(fp, '- [x] 要删\n- [x] 已归档\n- [ ] 新名\n- [ ] 全新行\n')

    const r = await svc.syncWithMd(fp, false)
    expect(tasks.getTask(a.id)).toBeUndefined() // 勾选 → 删除
    expect(tasks.getTask(b.id)).toBeDefined() // 已归档不动
    const renamed = tasks.getAllTasks().find((t) => t.title === '新名')
    expect(renamed).toBeDefined()
    expect(tasks.getAllTasks().some((t) => t.title === '旧名')).toBe(false)
    expect(tasks.getAllTasks().some((t) => t.title === '全新行')).toBe(true)
    // deleted=2：勾选的 '要删' + 改名行 hash 消失的 '旧名'（改行走删旧建新，hash 匹配语义）
    expect(r.deleted).toBe(2)
  })

  it('Phase2：绑定任务的行消失才删；空标题草稿豁免', async () => {
    const gone = await mkTask('行没了', { md_file_path: fp, md_line_hash: H('行没了') })
    const blank = await mkTask('', { md_file_path: fp, md_line_hash: H('') })
    fs.writeFileSync(fp, '- [ ] 别的\n')
    const r = await svc.syncWithMd(fp, false)
    expect(tasks.getTask(gone.id)).toBeUndefined()
    expect(tasks.getTask(blank.id)).toBeDefined() // 空标题豁免
    expect(r.deleted).toBe(1)
  })

  it('regenerateMd=false 不回写文件（watcher 单向保护）', async () => {
    await mkTask('数据库侧新任务')
    fs.writeFileSync(fp, '- [ ] 原有\n')
    const before = fs.readFileSync(fp, 'utf-8')
    await svc.syncWithMd(fp, false)
    expect(fs.readFileSync(fp, 'utf-8')).toBe(before)
    // regenerateMd=true 才回写
    await svc.syncWithMd(fp, true)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('- [ ] 数据库侧新任务')
  })
})

describe('updateTaskInMd / removeTaskFromMd / appendTaskToMd / moveTaskSubtreeInMd', () => {
  it('改名就地重写该行（不产生重复行）并更新绑定 hash', async () => {
    const t = await mkTask('旧名', { md_file_path: fp, md_line_hash: H('旧名') })
    fs.writeFileSync(fp, '- [ ] 旧名\n- [ ] 其他\n')
    await svc.updateTaskInMd(fp, t.id, '新名')
    const content = fs.readFileSync(fp, 'utf-8')
    expect(content).toBe('- [ ] 新名\n- [ ] 其他\n')
    expect(tasks.getTask(t.id)!.md_line_hash).toBe(H('新名'))
  })

  it('完成打勾：newStatus=archived → [x]', async () => {
    const t = await mkTask('任务', { md_file_path: fp, md_line_hash: H('任务') })
    fs.writeFileSync(fp, '- [ ] 任务\n')
    await svc.updateTaskInMd(fp, t.id, '任务', 'archived')
    expect(fs.readFileSync(fp, 'utf-8')).toBe('- [x] 任务\n')
  })

  it('删除单行（不删子树行）', async () => {
    const t = await mkTask('删我', { md_file_path: fp, md_line_hash: H('删我') })
    fs.writeFileSync(fp, '- [ ] 删我\n  - [ ] 子行\n')
    await svc.removeTaskFromMd(fp, t.id)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('  - [ ] 子行\n')
  })

  it('有父且父有 hash → 插在父行紧后并缩进', async () => {
    const p = await mkTask('父', { md_file_path: fp, md_line_hash: H('父') })
    fs.writeFileSync(fp, '- [ ] 父\n- [ ] 尾\n')
    await svc.appendTaskToMd(fp, tasks.createTask('插队', { parentId: p.id, skipDedup: true }))
    expect(fs.readFileSync(fp, 'utf-8')).toBe('- [ ] 父\n  - [ ] 插队\n- [ ] 尾\n')
  })

  it('层级变更 → 子树手术式搬移', async () => {
    const p = await mkTask('父', { md_file_path: fp, md_line_hash: H('父') })
    const c = await mkTask('子', { parent_id: p.id, md_file_path: fp, md_line_hash: H('子') })
    fs.writeFileSync(fp, '- [ ] 父\n- [ ] 子\n  注记\n- [ ] 尾\n')
    await svc.moveTaskSubtreeInMd(fp, c.id)
    const lines = fs.readFileSync(fp, 'utf-8').split('\n')
    expect(lines).toEqual(['- [ ] 父', '  - [ ] 子', '    注记', '- [ ] 尾', '']) // 注记保持相对深度
  })
})
