/**
 * mdSync 纯逻辑：epochtodo.md（checkbox bullet）与任务树之间的解析、生成与合并规划。
 * 对齐语义规格 §5.1–§5.4（EpochToDo electron/mdSync/pure.ts 行为，含已知瑕疵）。
 * 纯函数模块——不依赖 fs/db/electron，全部决策返回计划（plan），由 service 层执行 I/O。
 */
import { createHash } from 'node:crypto'
import type { TaskStatus, TaskType } from '../../../shared/todo-types'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 纯逻辑层所需的任务字段子集——TaskRow 天然满足此结构（结构化兼容）。
 * 可选字段对应旧数据/测试夹具的宽松输入，算法内部以 `?? ` 兜底。
 */
export interface MdTask {
  id: number
  title: string
  status: TaskStatus
  type?: TaskType | null
  parent_id: number | null
  sort_order?: number
  is_next_action?: number
  md_file_path?: string | null
  md_line_hash?: string | null
}

/** MD 文件里解析出的一条 checkbox bullet */
export interface ParsedBullet {
  /** 文件内零基行号 */
  lineIndex: number
  /** 缩进深度（0=根；tab=1 级、空格=0.5 级后 Math.floor） */
  depth: number
  /** `[ ] `/`[x] ` 之后的正文（已 trim） */
  text: string
  /** `[x]`/`[X]` 为 true */
  checked: boolean
  /** 内容 hash（md5(trim(text)) 前 16 位 hex），任务↔行绑定键 */
  hash: string
}

/** bullet + 按缩进推断的子树 */
export interface BulletNode {
  bullet: ParsedBullet
  children: BulletNode[]
}

/** computeTaskRepairs 算出的单任务列更新 */
export interface TaskRepairUpdates {
  title?: string
  status?: TaskStatus
  is_next_action?: number
  parent_id?: number | null
}

export interface TaskConflict {
  taskId: number
  oldTitle: string
  newTitle: string
}

export interface TaskRepair {
  updates: TaskRepairUpdates
  /** MD 侧与 DB 标题不一致时记录（MD 获胜） */
  conflict?: TaskConflict
}

export interface MdMergePlan {
  /** 合并后应写回文件的完整内容 */
  newContent: string
  /** 合并后文件中的 bullet 总数 */
  bulletCount: number
  /** 需要（重新）写入 md_file_path/md_line_hash 绑定的任务 */
  rebind: { id: number; hash: string }[]
  diagnostics: { matched: number; orphanChildren: number; newRoot: number }
}

export interface SubtreeMovePlan {
  newContent: string
  moved: boolean
}

/* ------------------------------------------------------------------ */
/* 基础（§5.1）                                                        */
/* ------------------------------------------------------------------ */

/** 16 位 hex 内容 hash：md5(trim(text)) 前 16 位——任务↔MD 行的绑定键 */
export function hashContent(text: string): string {
  return createHash('md5').update(text.trim()).digest('hex').slice(0, 16)
}

/** 缩进串→深度：tab=1 级、空格=0.5 级，Math.floor（3 空格=1 级、4 空格=2 级） */
function indentDepth(indent: string): number {
  let depth = 0
  for (const ch of indent) {
    if (ch === '\t') depth += 1
    else if (ch === ' ') depth += 0.5
  }
  return Math.floor(depth)
}

/**
 * 解析 MD 内容为 checkbox bullet 列表。
 * 仅识别 `^(\s*)([-*+])\s+(.+)$` 且正文匹配 `^\[( |x|X)\]\s+(.+)$` 的行；
 * 纯 `- text` 等非复选框行忽略；CRLF 兼容；lineIndex 从 0 计。
 */
export function parseMdContent(content: string): ParsedBullet[] {
  const lines = content.split(/\r?\n/)
  const bullets: ParsedBullet[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)([-*+])\s+(.+)$/)
    if (!match) continue

    // 仅复选框 bullet 算数：`- [ ]`/`- [x]`（后须有正文），纯文本 bullet 忽略
    const checkMatch = match[3].match(/^\[( |x|X)\]\s+(.+)$/)
    if (!checkMatch) continue

    const text = checkMatch[2].trim()
    bullets.push({
      lineIndex: i,
      depth: indentDepth(match[1]),
      text,
      checked: checkMatch[1].toLowerCase() === 'x',
      hash: hashContent(checkMatch[2]),
    })
  }

  return bullets
}

/**
 * 栈式建树：弹出所有 `depth >= 当前` 的栈顶；栈空为根，否则挂栈顶 children。
 */
export function buildBulletTree(bullets: ParsedBullet[]): BulletNode[] {
  const roots: BulletNode[] = []
  const stack: { node: BulletNode; depth: number }[] = []

  for (const bullet of bullets) {
    const node: BulletNode = { bullet, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].depth >= bullet.depth) {
      stack.pop()
    }
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ node, depth: bullet.depth })
  }

  return roots
}

/* ------------------------------------------------------------------ */
/* MD 生成（§5.1）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 由任务列表生成 MD：只出 standard/undefined 类型、非 archived、标题非空白的任务；
 * childrenMap 按 parent_id 分组、组内 sort_order 升序；2 空格缩进、末尾换行。
 * rootParentId 非空时只导出该子树（子树根按 depth 0 渲染）。
 */
export function generateMdFromTasks(tasks: MdTask[], rootParentId: number | null = null): string {
  const standardTasks = tasks.filter(
    (t) => (t.type === 'standard' || t.type === undefined) && t.status !== 'archived' && t.title.trim() !== '',
  )

  const childrenMap = new Map<number | null, MdTask[]>()
  for (const t of standardTasks) {
    const pid = t.parent_id ?? null
    if (!childrenMap.has(pid)) childrenMap.set(pid, [])
    childrenMap.get(pid)!.push(t)
  }
  for (const arr of childrenMap.values()) {
    arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  }

  const lines: string[] = []
  const renderTask = (task: MdTask, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${task.status === 'archived' ? '- [x] ' : '- [ ] '}${task.title}`)
    for (const child of childrenMap.get(task.id) ?? []) renderTask(child, depth + 1)
  }
  for (const root of childrenMap.get(rootParentId) ?? []) renderTask(root, 0)

  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------ */
/* 单任务修复（§5.2，MD→DB）                                           */
/* ------------------------------------------------------------------ */

/**
 * 未勾选 bullet 匹配到任务时的列修复（纯函数，调用方负责落库）：
 * title 不同 → 改 title 并记 conflict（MD 侧获胜）；archived → queued（只此方向）；
 * active 但无 focus timer（僵尸）→ queued；is_next_action≠1 → 1；parent 漂移 → 改回。
 */
export function computeTaskRepairs(
  existing: MdTask,
  newText: string,
  parentId: number | null,
  activeFocusTaskIds: Set<number>,
): TaskRepair {
  const updates: TaskRepairUpdates = {}
  let conflict: TaskConflict | undefined

  if (existing.title !== newText) {
    updates.title = newText
    conflict = { taskId: existing.id, oldTitle: existing.title, newTitle: newText }
  }
  if (existing.status === 'archived') {
    updates.status = 'queued'
  }
  if (existing.status === 'active' && !activeFocusTaskIds.has(existing.id)) {
    updates.status = 'queued'
  }
  if (existing.is_next_action !== 1) {
    updates.is_next_action = 1
  }
  if (existing.parent_id !== parentId) {
    updates.parent_id = parentId
  }

  return { updates, conflict }
}

/* ------------------------------------------------------------------ */
/* 合并规划（§5.3，DB→MD）                                             */
/* ------------------------------------------------------------------ */

/**
 * 规划 DB→MD 合并：hash 命中的行就地重写（保缩进与符号）；未入 MD 的 active 任务中
 * "父已在 MD"的孤儿子插到父子弹群末尾，其余树形追加到末尾非空行之后。
 * 已有 `[x]` 行与无法匹配的内容原样保留（`[x]` 行永不删除）。
 * content=null 表示文件不存在（全量生成）。纯函数——I/O 由调用方执行。
 */
export function planMdMerge(content: string | null, tasks: MdTask[], filePath: string): MdMergePlan {
  const standardTasks = tasks.filter(
    (t) => (t.type === 'standard' || t.type === undefined) && t.title.trim() !== '',
  )

  // 文件不存在：全量生成（仅非 archived），绑定缺失/路径不符者进 rebind
  if (content === null) {
    const activeTasks = standardTasks.filter((t) => t.status !== 'archived')
    const newContent = generateMdFromTasks(activeTasks)
    const rebind: { id: number; hash: string }[] = []
    for (const task of activeTasks) {
      if (task.md_file_path !== filePath || !task.md_line_hash) {
        rebind.push({ id: task.id, hash: hashContent(task.title) })
      }
    }
    const bulletCount = (newContent.match(/^\s*[-*+]\s/gm) || []).length
    return {
      newContent,
      bulletCount,
      rebind,
      diagnostics: { matched: 0, orphanChildren: 0, newRoot: bulletCount },
    }
  }

  const lines = content.split(/\r?\n/)
  const bullets = parseMdContent(content)

  // hash → 任务（含 archived，用于把已在文件里的行改成 [x]）；同 hash 后写覆盖
  const taskByHash = new Map<string, MdTask>()
  for (const t of standardTasks) taskByHash.set(hashContent(t.title), t)

  const matchedTaskIds = new Set<number>()
  const matchedBulletMap = new Map<number, { lineIndex: number; depth: number }>()
  const rebind: { id: number; hash: string }[] = []

  // ① hash 命中 → 就地重写该行（保留原缩进与符号），check 状态 = 任务是否 archived
  for (const bullet of bullets) {
    const task = taskByHash.get(bullet.hash)
    if (!task) continue

    matchedTaskIds.add(task.id)
    matchedBulletMap.set(task.id, { lineIndex: bullet.lineIndex, depth: bullet.depth })
    const match = lines[bullet.lineIndex].match(/^(\s*)([-*+])\s/)
    const indent = match ? match[1] : ''
    const marker = match ? match[2] : '-'
    lines[bullet.lineIndex] = `${indent}${marker} ${task.status === 'archived' ? '[x] ' : '[ ] '}${task.title}`

    if (task.md_line_hash !== bullet.hash || task.md_file_path !== filePath) {
      rebind.push({ id: task.id, hash: bullet.hash })
    }
  }

  // ② 未入 MD 的 active 任务分两类：孤儿子（父已在 MD）vs 全新（无父或父也是新的）
  const activeNotInMd = standardTasks.filter((t) => t.status !== 'archived' && !matchedTaskIds.has(t.id))
  const orphanChildren: MdTask[] = []
  const trulyNewTasks: MdTask[] = []
  for (const t of activeNotInMd) {
    if (t.parent_id && matchedTaskIds.has(t.parent_id)) orphanChildren.push(t)
    else trulyNewTasks.push(t)
  }

  // 孤儿子：按父分组、组内 sort_order 排序，插到父子弹群末尾
  const orphansByParent = new Map<number, MdTask[]>()
  for (const t of orphanChildren) {
    const pid = t.parent_id!
    if (!orphansByParent.has(pid)) orphansByParent.set(pid, [])
    orphansByParent.get(pid)!.push(t)
  }
  for (const arr of orphansByParent.values()) arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  const insertions: { at: number; texts: string[] }[] = []
  for (const [parentId, children] of orphansByParent) {
    const parentInfo = matchedBulletMap.get(parentId)
    if (!parentInfo) continue
    const childIndent = '  '.repeat(parentInfo.depth + 1)

    // 沿"下一行 depth>父 depth"扫描找子弹群末尾（非 bullet 行含空行也参与推进）
    let insertAfter = parentInfo.lineIndex
    while (insertAfter + 1 < lines.length) {
      const nextMatch = lines[insertAfter + 1].match(/^(\s*)([-*+])\s/)
      if (!nextMatch) {
        insertAfter++
        continue
      }
      if (indentDepth(nextMatch[1]) > parentInfo.depth) insertAfter++
      else break
    }

    insertions.push({
      at: insertAfter + 1,
      texts: children.map((t) => `${childIndent}- [ ] ${t.title}`),
    })
  }
  // 从后往前 splice 保索引
  insertions.sort((a, b) => b.at - a.at)
  for (const ins of insertions) lines.splice(ins.at, 0, ...ins.texts)

  // 全新任务：树形渲染追加到"最后一个非空行之后"（保留尾部空行）
  const childrenMap = new Map<number | null, MdTask[]>()
  for (const t of trulyNewTasks) {
    const pid = t.parent_id ?? null
    if (!childrenMap.has(pid)) childrenMap.set(pid, [])
    childrenMap.get(pid)!.push(t)
  }
  for (const arr of childrenMap.values()) arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  const newLines: string[] = []
  const renderAppend = (task: MdTask, depth: number): void => {
    newLines.push(`${'  '.repeat(depth)}- [ ] ${task.title}`)
    for (const child of childrenMap.get(task.id) ?? []) renderAppend(child, depth + 1)
  }
  for (const root of childrenMap.get(null) ?? []) renderAppend(root, 0)

  if (newLines.length > 0) {
    let insertAt = lines.length
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, ...newLines)
  }

  // ③ 追加任务的绑定缺失/路径不符 → rebind
  for (const task of activeNotInMd) {
    if (task.md_file_path !== filePath || !task.md_line_hash) {
      rebind.push({ id: task.id, hash: hashContent(task.title) })
    }
  }

  return {
    newContent: lines.join('\n'),
    bulletCount: bullets.length + orphanChildren.length + newLines.length,
    rebind,
    diagnostics: { matched: matchedTaskIds.size, orphanChildren: orphanChildren.length, newRoot: newLines.length },
  }
}

/* ------------------------------------------------------------------ */
/* 子树搬移（§5.4，层级变更的手术式移动）                              */
/* ------------------------------------------------------------------ */

/**
 * 规划单任务子树在 MD 文件里的搬移（缩进/换位）：bullet 行 + 其后所有"更深 bullet 或
 * 非 bullet 行（注记）"整段抽出、按新父目标深度重缩进（注记保持相对深度）、插到
 * 父子弹群末尾 / 前一根兄弟子群末尾 / 文件末。其余字节原样保留——防止 watcher 的
 * MD→DB 合并拿旧缩进把 parent_id 修回去。纯函数；找不到任务/bullet 返回 null。
 */
export function planSubtreeMove(content: string, tasks: MdTask[], taskId: number): SubtreeMovePlan | null {
  const active = tasks.filter(
    (t) => (t.type === 'standard' || t.type === undefined) && t.status !== 'archived' && t.title.trim() !== '',
  )
  const task = active.find((t) => t.id === taskId)
  if (!task) return null

  const lines = content.split(/\r?\n/)
  const bullets = parseMdContent(content)
  const byHash = new Map(bullets.map((b) => [b.hash, b]))
  const bulletFor = (t: MdTask): ParsedBullet | undefined =>
    (t.md_line_hash ? byHash.get(t.md_line_hash) : undefined) ?? byHash.get(hashContent(t.title))

  const bullet = bulletFor(task)
  if (!bullet) return null

  const lineDepth = (i: number): number | null => {
    const m = lines[i].match(/^(\s*)([-*+])\s/)
    return m ? indentDepth(m[1]) : null
  }

  // 子树跨度 = bullet 行 + 之后所有"更深 bullet 或非 bullet 行"；同深/更浅 bullet 结束跨度
  const subtreeEnd = (start: ParsedBullet, skipFrom = -1, skipTo = -1): number => {
    let end = start.lineIndex
    for (let i = start.lineIndex + 1; i < lines.length; i++) {
      if (i >= skipFrom && i <= skipTo) continue
      const d = lineDepth(i)
      if (d === null || d > start.depth) {
        end = i
        continue
      }
      break
    }
    return end
  }

  let myEnd = subtreeEnd(bullet)
  // 尾部空行不算子树（否则重缩进会留下纯空白行）
  while (myEnd > bullet.lineIndex && lines[myEnd].trim() === '') myEnd--

  // 目标深度 = 新父 bullet.depth+1（无父=0）
  const parentTask = task.parent_id != null ? active.find((t) => t.id === task.parent_id) : undefined
  const parentBullet = parentTask ? bulletFor(parentTask) : undefined
  const targetDepth = parentBullet ? parentBullet.depth + 1 : 0

  // 插入锚点（原始行号系）：父子弹群末尾（跳过自身跨度）；无父按 sort_order 找
  // 前一根兄弟子群末尾，否则下一根兄弟之前，否则文件末；父即自身/不可解 → 原地
  let insertAfter: number
  if (parentBullet && parentBullet.lineIndex !== bullet.lineIndex) {
    insertAfter = subtreeEnd(parentBullet, bullet.lineIndex, myEnd)
  } else if (!parentBullet) {
    const roots = active
      .filter((t) => t.parent_id == null)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    const myIdx = roots.findIndex((t) => t.id === taskId)
    let anchor: ParsedBullet | undefined
    let before = false
    for (let i = myIdx - 1; i >= 0; i--) {
      const b = bulletFor(roots[i])
      if (b) {
        anchor = b
        break
      }
    }
    if (!anchor) {
      for (let i = myIdx + 1; i < roots.length; i++) {
        const b = bulletFor(roots[i])
        if (b && b.lineIndex !== bullet.lineIndex) {
          anchor = b
          before = true
          break
        }
      }
    }
    if (!anchor) {
      const last = bullets[bullets.length - 1]
      insertAfter =
        last && last.lineIndex !== bullet.lineIndex ? subtreeEnd(last, bullet.lineIndex, myEnd) : lines.length - 2
    } else if (before) {
      insertAfter = anchor.lineIndex - 1
    } else {
      insertAfter = subtreeEnd(anchor, bullet.lineIndex, myEnd)
    }
  } else {
    // 父即自身/不可解 —— 原地不动
    insertAfter = myEnd
  }

  const delta = targetDepth - bullet.depth
  if (insertAfter === myEnd && delta === 0) {
    return { newContent: content, moved: false }
  }

  // 抽出跨度，插入索引按抽出量校正，整段按相对深度重缩进后 splice 回
  const span = lines.splice(bullet.lineIndex, myEnd - bullet.lineIndex + 1)
  let insertAt = insertAfter + 1
  if (insertAfter > myEnd) insertAt -= span.length

  const reindented = span.map((l) => {
    if (delta === 0) return l
    const m = l.match(/^(\s*)(.*)$/s)
    if (!m) return l
    const rel = Math.max(0, indentDepth(m[1]) - bullet.depth)
    return '  '.repeat(Math.max(0, targetDepth + rel)) + m[2]
  })
  lines.splice(Math.min(insertAt, lines.length), 0, ...reindented)

  return { newContent: lines.join('\n'), moved: true }
}
