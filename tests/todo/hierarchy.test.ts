import { describe, it, expect } from 'vitest'
import { buildTaskTree, getAncestorChain, type TreeTask } from '../../src/main/todo/hierarchy'

let seq = 0
function mk(
  id: number,
  parent_id: number | null,
  status = 'queued',
  opts: { sort_order?: number; created_at?: string; title?: string } = {},
): TreeTask {
  return {
    id,
    parent_id,
    status,
    title: opts.title ?? `t${id}`,
    sort_order: opts.sort_order ?? id,
    created_at: opts.created_at ?? new Date(2026, 0, 1, 0, 0, seq++).toISOString(),
  }
}

describe('buildTaskTree', () => {
  it('过滤 archived，孤儿（父缺失/已归档）提升为根', () => {
    const tree = buildTaskTree([
      mk(1, null),
      mk(2, 1),
      mk(3, 99), // 父不存在
      mk(4, 1, 'archived'), // 被过滤
      mk(5, 4), // 父已归档 → 提升为根
    ])
    const roots = tree.map((n) => n.task.id)
    expect(roots.sort()).toEqual([1, 3, 5])
    const n1 = tree.find((n) => n.task.id === 1)!
    expect(n1.children.map((c) => c.task.id)).toEqual([2])
  })

  it('同级排序严格为 prio 降序 → sort_order 升序 → created_at 升序', () => {
    const tasks = [
      mk(1, null, 'queued', { title: 'plain', sort_order: 5 }),
      mk(2, null, 'queued', { title: 'loud!!', sort_order: 9 }),
      mk(3, null, 'queued', { title: 'mid!', sort_order: 1 }),
      mk(4, null, 'queued', { title: 'plain2', sort_order: 5, created_at: new Date(2026, 0, 2).toISOString() }),
      mk(5, null, 'queued', { title: 'plain3', sort_order: 5, created_at: new Date(2025, 0, 1).toISOString() }),
    ]
    // prio：2(2) > 3(1) > 其余(0)；plain 组内 sort_order 相同按 created_at 升序：5 → 1 → 4
    const tree = buildTaskTree(tasks, new Map([[2, 2], [3, 1]]))
    expect(tree.map((n) => n.task.id)).toEqual([2, 3, 5, 1, 4])
  })

  it('parent_id 成环不死循环：环上节点不进入树输出（源码行为）', () => {
    const tree = buildTaskTree([mk(1, 2), mk(2, 1), mk(3, null)])
    expect(tree.map((n) => n.task.id)).toEqual([3])
  })

  it('递归赋 depth', () => {
    const tree = buildTaskTree([mk(1, null), mk(2, 1), mk(3, 2)])
    const n = tree[0]
    expect(n.depth).toBe(0)
    expect(n.children[0].depth).toBe(1)
    expect(n.children[0].children[0].depth).toBe(2)
  })

  it('同级排序支持外部传入的聚合优先级（缺省按 0 计）', () => {
    const tasks = [
      mk(1, null, 'queued', { title: 'parent', sort_order: 1 }),
      mk(2, 1, 'queued', { title: 'child!!', sort_order: 2 }),
      mk(3, null, 'queued', { title: 'rival!', sort_order: 0 }),
    ]
    const plain = buildTaskTree(tasks)
    // 无 priorities：prio 全按 0 → sort_order 升序：3(0) → 1(1)
    expect(plain.map((n) => n.task.id)).toEqual([3, 1])
    const agg = buildTaskTree(tasks, new Map([[1, 2], [2, 2], [3, 1]]))
    // 聚合 prio：1(2) > 3(1)
    expect(agg.map((n) => n.task.id)).toEqual([1, 3])
  })
})

describe('getAncestorChain', () => {
  it('root→直系父顺序', () => {
    const tasks = [mk(1, null), mk(2, 1), mk(3, 2)]
    expect(getAncestorChain(tasks, 3).map((t) => t.id)).toEqual([1, 2])
    expect(getAncestorChain(tasks, 1)).toEqual([])
  })

  it('maxDepth=5 截断', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => mk(i + 1, i === 0 ? null : i))
    // 链 8→7→6→5→4→3→2→1，取 5 级：3,4,5,6,7
    expect(getAncestorChain(tasks, 8).map((t) => t.id)).toEqual([3, 4, 5, 6, 7])
  })

  it('父缺失返回部分链', () => {
    const tasks = [mk(2, 1), mk(3, 2)] // 1 不在列表
    expect(getAncestorChain(tasks, 3).map((t) => t.id)).toEqual([2])
  })

  it('成环不死循环且不含重复', () => {
    const tasks = [mk(1, 3), mk(2, 1), mk(3, 2)]
    const chain = getAncestorChain(tasks, 3).map((t) => t.id)
    expect(new Set(chain).size).toBe(chain.length)
    expect(chain.length).toBeLessThanOrEqual(5)
  })
})
