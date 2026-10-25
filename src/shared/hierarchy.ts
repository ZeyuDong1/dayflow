/**
 * 任务层级（纯函数，无任何依赖）。
 * buildTaskTree：扁平任务 → 层级树；getAncestorChain：祖先链（面包屑用）。
 * 两者对 parent_id 成环的脏数据都安全（不死循环）。
 */

export interface TreeTask {
  id: number
  title: string
  parent_id: number | null
  status: string
  sort_order?: number
  created_at?: string
}

export interface TaskNode<T extends TreeTask = TreeTask> {
  task: T
  children: TaskNode<T>[]
  depth: number
}

/** 过滤 archived；孤儿（父缺失/已归档）提升为根；同级 prio 降序→sort_order 升序→created_at 升序。 */
export function buildTaskTree<T extends TreeTask>(tasks: T[], priorities?: Map<number, number>): TaskNode<T>[] {
  const activeTasks = tasks.filter((t) => t.status !== 'archived')
  const byId = new Map<number, TaskNode<T>>()
  const childrenMap = new Map<number | null, T[]>()

  for (const t of activeTasks) {
    byId.set(t.id, { task: t, children: [], depth: 0 })
  }

  for (const t of activeTasks) {
    const parentKey = t.parent_id != null && byId.has(t.parent_id) ? t.parent_id : null
    const list = childrenMap.get(parentKey)
    if (list) list.push(t)
    else childrenMap.set(parentKey, [t])
  }

  const prio = (t: T) => priorities?.get(t.id) ?? 0
  const sortSiblings = (arr: T[]) =>
    arr.sort((a, b) => {
      const pa = prio(a)
      const pb = prio(b)
      if (pa !== pb) return pb - pa
      const sa = a.sort_order ?? 0
      const sb = b.sort_order ?? 0
      if (sa !== sb) return sa - sb
      return (new Date(a.created_at ?? '').getTime() || 0) - (new Date(b.created_at ?? '').getTime() || 0)
    })

  const build = (parent: T | null, depth: number): TaskNode<T>[] => {
    const siblings = childrenMap.get(parent?.id ?? null) ?? []
    sortSiblings(siblings)
    return siblings.map((t) => {
      const node = byId.get(t.id)!
      node.depth = depth
      node.children = build(t, depth + 1)
      return node
    })
  }

  return build(null, 0)
}

/** 祖先链，root→直系父顺序；防环、深度截断（默认 5）、父缺失返回部分链。 */
export function getAncestorChain<T extends { id: number; parent_id: number | null }>(
  tasks: T[],
  taskId: number,
  maxDepth = 5,
): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const chain: T[] = []
  const visited = new Set<number>([taskId])

  let parent = byId.get(taskId)?.parent_id
  while (parent != null && chain.length < maxDepth && !visited.has(parent)) {
    const node = byId.get(parent)
    if (!node) break
    chain.unshift(node)
    visited.add(parent)
    parent = node.parent_id
  }
  return chain
}
