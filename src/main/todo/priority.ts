/**
 * Bang 优先级（纯函数，无任何依赖）。
 * 标题里任意位置的 `!` 个数即任务权重；聚合规则 subtree-max：
 * 父任务取自身与整棵子树的最大值（只向上传播，父的 !! 不抬子）。
 * Overlay 的 3 个队列槽位故意不用聚合，只看任务自身 bang 数。
 */

export interface BangTask {
  id: number
  title: string
  parent_id: number | null
}

export function countBangs(title: string): number {
  let n = 0
  for (const ch of title) if (ch === '!') n++
  return n
}

export function computeBangPriorities(tasks: BangTask[]): Map<number, number> {
  const childrenOf = new Map<number, BangTask[]>()
  for (const t of tasks) {
    if (t.parent_id == null) continue
    const list = childrenOf.get(t.parent_id)
    if (list) list.push(t)
    else childrenOf.set(t.parent_id, [t])
  }

  const memo = new Map<number, number>()
  const visiting = new Set<number>()
  const resolve = (t: BangTask): number => {
    const cached = memo.get(t.id)
    if (cached !== undefined) return cached
    if (visiting.has(t.id)) return 0 // 父子成环（脏数据）：回边按无信息处理
    visiting.add(t.id)
    let best = countBangs(t.title)
    for (const c of childrenOf.get(t.id) ?? []) {
      best = Math.max(best, resolve(c))
    }
    visiting.delete(t.id)
    memo.set(t.id, best)
    return best
  }

  for (const t of tasks) resolve(t)
  return memo
}
