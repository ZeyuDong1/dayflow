import { describe, it, expect } from 'vitest'
import { parseCommand } from '../../src/main/todo/commands'
import {
  executeCommand,
  confirmGpuPick,
  cleanupDraftTasks,
  type ExecDomainOps,
  type ExecCtx,
} from '../../src/main/todo/execute-command'
import type { TaskRow } from '../../src/shared/todo-types'

let seq = 100
function mkTask(over: Partial<TaskRow> & { id: number; title: string }): TaskRow {
  return {
    status: 'queued',
    type: 'standard',
    context_memo: null,
    total_duration: 0,
    estimated_duration: null,
    tag: null,
    project_id: null,
    parent_id: null,
    is_next_action: 1,
    is_side_focus: 0,
    side_focus_at: null,
    sort_order: over.id,
    gpu_id: null,
    last_focused_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    is_webhook: 0,
    md_file_path: null,
    md_line_hash: null,
    ...over,
  }
}

function makeFake(opts: {
  tasks?: TaskRow[]
  projects?: { id: number; name: string }[]
  gpus?: { id: number; name: string }[]
} = {}) {
  let tasks = [...(opts.tasks ?? [])]
  let localSeq = 100 // 每个 fake 独立计数，避免跨用例漂移
  const calls: string[] = []
  const domain: ExecDomainOps = {
    getTasks: () => tasks,
    listTaskProjects: () => opts.projects ?? [{ id: 10, name: 'LLM' }],
    getGpus: () => opts.gpus ?? [{ id: 1, name: 'A100' }],
    createTask: (title, o) => {
      const row = mkTask({
        id: ++localSeq,
        title,
        type: (o.type ?? 'standard') as TaskRow['type'],
        project_id: o.projectId ?? null,
        parent_id: o.parentId ?? null,
        is_next_action: 0,
      })
      tasks.push(row)
      calls.push(`create:${title}:${o.type ?? 'standard'}:p${o.parentId ?? '-'}:proj${o.projectId ?? '-'}`)
      return row
    },
    updateTask: (id, updates) => {
      calls.push(`update:${id}:${JSON.stringify(updates)}`)
      const t = tasks.find((x) => x.id === id)
      return t ? Object.assign(t, updates) : null
    },
    appendMemo: (id, text) => calls.push(`memo:${id}:${text}`),
    startFocus: (id) => calls.push(`focus:${id}`),
    startWait: (id, s) => calls.push(`wait:${id}:${s}`),
    assignTaskToGpu: (tid, gid, m) => calls.push(`gpu:${tid}:${gid}:${m}`),
  }
  return { calls, domain, tasks: () => tasks }
}

function ctxOf(fake: ReturnType<typeof makeFake>, over: Partial<ExecCtx> = {}): ExecCtx {
  return {
    activeTask: null,
    highlighted: null,
    suggestions: [],
    domain: fake.domain,
    ...over,
  }
}

describe('executeCommand', () => {
  it('MEMO → appendMemo(活动任务)；无活动任务 noop', () => {
    const f = makeFake()
    const active = mkTask({ id: 1, title: 'A' })
    expect(executeCommand(parseCommand('> 内容'), ctxOf(f, { activeTask: active }))).toEqual({ kind: 'done', taskId: 1 })
    expect(f.calls).toEqual(['memo:1:内容'])
    const f2 = makeFake()
    expect(executeCommand(parseCommand('> 内容'), ctxOf(f2)).kind).toBe('noop')
  })

  it('SUSPEND：有活动 → startWait(活动)；无活动 → 建"提醒"reminder 并 startWait', () => {
    const f = makeFake()
    const active = mkTask({ id: 1, title: 'A' })
    executeCommand(parseCommand('@25m'), ctxOf(f, { activeTask: active }))
    expect(f.calls).toEqual(['wait:1:1500'])

    const f2 = makeFake()
    executeCommand(parseCommand('@25m'), ctxOf(f2))
    expect(f2.calls).toEqual(['create:提醒:reminder:p-:proj-', 'wait:101:1500'])
  })

  it('审查重点#1：FOCUS 切换+挂起先 wait(旧) 再 focus(新)', () => {
    const f = makeFake({ tasks: [mkTask({ id: 1, title: '旧' }), mkTask({ id: 2, title: '新' })] })
    const active = f.tasks()[0]
    executeCommand(parseCommand('!新 @25m'), ctxOf(f, { activeTask: active }))
    expect(f.calls).toEqual(['update:2:{"is_next_action":1}', 'wait:1:1500', 'focus:2'])
  })

  it('FOCUS：无 time → startFocus；有 time 无活动 → startWait(目标)', () => {
    const f = makeFake({ tasks: [mkTask({ id: 2, title: '新' })] })
    executeCommand(parseCommand('!新'), ctxOf(f))
    expect(f.calls).toEqual(['update:2:{"is_next_action":1}', 'focus:2'])

    const f2 = makeFake({ tasks: [mkTask({ id: 2, title: '新' })] })
    executeCommand(parseCommand('!新 @25m'), ctxOf(f2))
    expect(f2.calls).toEqual(['update:2:{"is_next_action":1}', 'wait:2:1500'])
  })

  it('CREATE 仅创建入队置 next_action；REMINDER 建 reminder 并 startWait(缺省 1800)', () => {
    const f = makeFake()
    executeCommand(parseCommand('买牛奶'), ctxOf(f))
    expect(f.calls[0]).toBe('create:买牛奶:standard:p-:proj-')
    expect(f.calls[1]).toBe('update:101:{"is_next_action":1}')
    expect(f.calls.length).toBe(2)

    const f2 = makeFake()
    executeCommand(parseCommand('+ 洗衣服'), ctxOf(f2))
    expect(f2.calls).toEqual(['create:洗衣服:reminder:p-:proj-', 'update:101:{"is_next_action":1}', 'wait:101:1800'])

    const f3 = makeFake()
    executeCommand(parseCommand('+ 洗衣服 @10m'), ctxOf(f3))
    expect(f3.calls[2]).toBe('wait:101:600')
  })

  it('审查重点#3：目标解析 高亮(FOCUS) > 精确标题(不分大小写/限项目/排除archived) > 新建', () => {
    const existing = mkTask({ id: 5, title: 'Write Docs', project_id: 10 })
    const f = makeFake({ tasks: [existing] })
    executeCommand(parseCommand('!write docs $LLM'), ctxOf(f))
    expect(f.calls).toContain('focus:5') // 精确匹配（大小写不敏感、项目一致）

    const hi = mkTask({ id: 7, title: '别的' })
    const f2 = makeFake({ tasks: [existing, hi] })
    executeCommand(parseCommand('!write docs'), ctxOf(f2, { highlighted: hi }))
    expect(f2.calls).toContain('focus:7') // 高亮优先

    const f3 = makeFake({ tasks: [mkTask({ id: 5, title: 'Write Docs', project_id: 99 })] })
    executeCommand(parseCommand('!write docs $LLM'), ctxOf(f3))
    expect(f3.calls[0].startsWith('create:write docs:standard')).toBe(true) // 项目不符 → 新建

    const archived = mkTask({ id: 8, title: 'Write Docs', status: 'archived' })
    const f4 = makeFake({ tasks: [archived] })
    executeCommand(parseCommand('!write docs'), ctxOf(f4))
    expect(f4.calls[0].startsWith('create:')).toBe(true) // archived 不匹配
  })

  it('审查重点#2：子任务同级语义（活动是子→兄弟；是根→子）与 Context 备忘', () => {
    const parent = mkTask({ id: 1, title: '父', project_id: 10 })
    const child = mkTask({ id: 2, title: '子', parent_id: 1, project_id: 10 })
    const f = makeFake({ tasks: [parent, child] })
    executeCommand(parseCommand('兄弟:'), ctxOf(f, { activeTask: child }))
    expect(f.calls[0]).toBe('create:兄弟:standard:p1:proj10') // 挂到父（=兄弟）

    const f2 = makeFake({ tasks: [parent, child] })
    executeCommand(parseCommand('后代:'), ctxOf(f2, { activeTask: parent }))
    expect(f2.calls[0]).toBe('create:后代:standard:p1:proj10') // 根任务 → 子

    const f3 = makeFake({ tasks: [parent, child] })
    executeCommand(parseCommand('挂载:父搜索'), ctxOf(f3, { suggestions: [parent] }))
    expect(f3.calls[0]).toBe('create:挂载:standard:p1:proj10') // 父搜索模式

    const f4 = makeFake({ tasks: [mkTask({ id: 2, title: '新' })] })
    executeCommand(parseCommand('任务!上下文'), ctxOf(f4))
    expect(f4.calls).toContain('memo:101:Context: 上下文')
  })

  it('TRAINING 带时间无 GPU → needGpu-pick；confirmGpuPick 建任务+备忘+分配（审查重点#4 路径）', () => {
    const f = makeFake()
    const res = executeCommand(parseCommand('%训练模型 @2h'), ctxOf(f))
    expect(res.kind).toBe('need-gpu-pick')
    const draft = (res as { kind: 'need-gpu-pick'; draft: { title: string; time: number; projectId: number | null } }).draft
    expect(draft).toMatchObject({ title: '训练模型', time: 7200, projectId: null })
    confirmGpuPick(ctxOf(f), { ...draft, sub: 'v2' }, 1)
    expect(f.calls).toEqual(['create:训练模型:training:p-:proj-', 'memo:101:Context: v2', 'gpu:101:1:120'])
  })

  it('水槽用例：! finetune bert`A100 @90m $LLM!v2 → TRAINING 指定 GPU 分配', () => {
    const f = makeFake()
    executeCommand(parseCommand('! finetune bert`A100 @90m $LLM!v2'), ctxOf(f))
    expect(f.calls).toEqual([
      'create:finetune bert:training:p-:proj10',
      'update:101:{"is_next_action":1}',
      'memo:101:Context: v2',
      'gpu:101:1:90',
    ])
  })

  it('审查重点#4：GPU 模糊不中 → 任务留队列仅警告，无 assign', () => {
    const f = makeFake()
    const warn: unknown[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warn.push(a[0])
    executeCommand(parseCommand('%模型 `不存在 @2h'), ctxOf(f))
    console.warn = orig
    expect(f.calls.some((c) => c.startsWith('gpu:'))).toBe(false)
    expect(f.calls.some((c) => c.startsWith('create:模型:training'))).toBe(true)
    expect(warn.length).toBe(1)
  })
})

describe('cleanupDraftTasks', () => {
  it('审查重点#5：只删空白标题且非 active/archived', () => {
    const rows = [
      { id: 1, title: '   ', status: 'queued' as const },
      { id: 2, title: '', status: 'active' as const },
      { id: 3, title: '', status: 'archived' as const },
      { id: 4, title: '真实任务', status: 'queued' as const },
    ]
    const deleted: number[] = []
    cleanupDraftTasks(rows, (id) => deleted.push(id))
    expect(deleted).toEqual([1])
  })
})
