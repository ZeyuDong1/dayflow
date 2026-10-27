import { db } from './db'
import { dayStartTs, todayKey } from './paths'
import type {
  Project,
  Rule,
  RuleCondition,
  RuleNode,
  ProjectSuggestion,
  RuleSuggestionItem,
  ProjectStats,
  ProjectsOverview,
  ClassificationEntry
} from '../shared/types'

// ---------------------------------------------------------------------------
// Default projects (created on first run)
// ---------------------------------------------------------------------------

export const DEFAULT_PROJECTS: {
  title: string
  color: string
  productivityScore: number
  hints: string
}[] = [
  { title: '编码开发', color: '#4a5fd9', productivityScore: 9, hints: 'IDE、终端、代码编辑器、版本控制、数据库工具' },
  { title: '文档写作', color: '#7ba8e8', productivityScore: 8, hints: '笔记、Word、文档、博客、邮件撰写' },
  { title: '设计创作', color: '#c79be8', productivityScore: 8, hints: '图像、UI、视频剪辑、原型、绘图工具' },
  { title: '沟通交流', color: '#f08a6a', productivityScore: 6, hints: '聊天、会议、邮件客户端、VoIP' },
  { title: '调研学习', color: '#4fd1b5', productivityScore: 8, hints: '文档阅读、搜索、教程、PDF、课程' },
  { title: '网页浏览', color: '#d4a843', productivityScore: 3, hints: '无明确目的的浏览、购物、新闻' },
  { title: '娱乐消遣', color: '#e05252', productivityScore: 1, hints: '游戏、视频、音乐、流媒体' },
  { title: '系统与工具', color: '#6f665a', productivityScore: 4, hints: '文件管理器、设置、系统工具、下载' }
]

/** Create the default project set once (when the projects table is empty). */
export function ensureDefaultProjects(): void {
  const count = db.count('SELECT COUNT(*) AS c FROM projects')
  if (count > 0) return
  DEFAULT_PROJECTS.forEach((p, i) => {
    db.run(
      `INSERT INTO projects (parent_id, title, color, productivity_score, billable_by_default, list_position)
       VALUES (NULL, ?, ?, ?, 0, ?)`,
      [p.title, p.color, p.productivityScore, i]
    )
  })
}

// ---------------------------------------------------------------------------
// Projects (Timing: infinite hierarchy, color, productivity score)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number
  parent_id: number | null
  title: string
  color: string
  productivity_score: number
  billable_by_default: number
  list_position: number
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    color: r.color,
    productivityScore: r.productivity_score,
    billableByDefault: r.billable_by_default === 1,
    listPosition: r.list_position
  }
}

export function listProjects(): Project[] {
  const rows = db.all<ProjectRow>('SELECT * FROM projects WHERE is_deleted = 0 ORDER BY list_position, id')
  return rows.map(rowToProject)
}

export function createProject(input: {
  title: string
  parentId?: number | null
  color?: string
  productivityScore?: number
  billableByDefault?: boolean
}): Project {
  const pos =
    db.count('SELECT COUNT(*) AS c FROM projects WHERE is_deleted = 0 AND (parent_id IS ? OR parent_id = ?)', [
      input.parentId ?? null,
      input.parentId ?? -1
    ]) + 1
  db.run(
    `INSERT INTO projects (parent_id, title, color, productivity_score, billable_by_default, list_position)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.parentId ?? null,
      input.title,
      input.color ?? '#e8763a',
      input.productivityScore ?? 0,
      input.billableByDefault ? 1 : 0,
      pos
    ]
  )
  const id = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 }).id
  return listProjects().find((p) => p.id === id)!
}

export function updateProject(id: number, patch: Partial<Project>): void {
  const p = listProjects().find((x) => x.id === id)
  if (!p) return
  db.run(
    `UPDATE projects SET title = ?, color = ?, productivity_score = ?, billable_by_default = ?, parent_id = ?, list_position = ? WHERE id = ?`,
    [
      patch.title ?? p.title,
      patch.color ?? p.color,
      patch.productivityScore ?? p.productivityScore,
      (patch.billableByDefault ?? p.billableByDefault) ? 1 : 0,
      patch.parentId !== undefined ? patch.parentId : p.parentId,
      patch.listPosition ?? p.listPosition,
      id
    ]
  )
}

export function deleteProject(id: number): void {
  // Cascade: unassign activities, delete rules, soft-delete children too.
  const children = listProjects().filter((p) => p.parentId === id)
  for (const c of children) deleteProject(c.id)
  db.run('UPDATE projects SET is_deleted = 1 WHERE id = ?', [id])
  db.run('UPDATE rules SET is_deleted = 1 WHERE project_id = ?', [id])
  db.run('UPDATE app_activities SET project_id = NULL WHERE project_id = ?', [id])
  db.run('UPDATE task_activities SET project_id = NULL WHERE project_id = ?', [id])
}

// ---------------------------------------------------------------------------
// Browsers: classify by PAGE (title), never by the exe alone
// ---------------------------------------------------------------------------

const BROWSER_APPS = [
  'zen', 'chrome', 'chromium', 'msedge', 'edge', 'firefox', 'brave', 'opera',
  'vivaldi', 'arc', 'wave', 'librewolf', 'waterfox', 'tor-browser', 'com.tinyspeck' // slack excluded below
].map((x) => x.toLowerCase())

export function isBrowserApp(appName: string): boolean {
  const a = appName.toLowerCase().replace(/\.exe$/, '')
  return BROWSER_APPS.some((b) => a === b || a.startsWith(b))
}

/** Common site hints from page titles -> default project (zero-cost classification). */
const SITE_HINTS: [RegExp, string][] = [
  [/哔哩哔哩|bilibili|youtube|腾讯视频|爱奇艺|优酷|芒果tv|netflix|disney\+|spotify|网易云音乐|qq音乐|抖音|douyin|tiktok/i, '娱乐消遣'],
  [/github|gitlab|gitee|stack\s*overflow|juejin|掘金|csdn|segmentfault|v2ex|leetcode|力扣/i, '编码开发'],
  [/arxiv|论文|scholar|google\s*学术|知网|cnki|文档|docs\.|developer|api参考|tutorial|教程|wikipedia|维基|知乎|zhihu/i, '调研学习'],
  [/淘宝|天猫|京东|pdd|拼多多|亚马逊|amazon|闲鱼|苏宁|唯品会/i, '网页浏览'],
  [/微博|weibo|twitter|\/\/x\.com|reddit|贴吧|豆瓣|小红书|facebook|instagram|threads/i, '网页浏览'],
  [/gmail|outlook|qq邮箱|163\.com|mail\.|飞书|lark/i, '沟通交流'],
  [/notion|语雀|yuque|obsidian|heptabase|onenote|印象笔记|为知/i, '文档写作'],
  [/战网|battle\.net|steam|epic\s*games|riot|league\s*of\s*legends|原神|崩坏|米哈游|mihoyo/i, '娱乐消遣']
]

export function siteHintProject(title: string): string | null {
  for (const [re, proj] of SITE_HINTS) {
    if (re.test(title)) return proj
  }
  return null
}

/** Coarse title bucket used for per-title classification caching and suggestions. */
export function titlePattern(title: string): string {
  const clean = (title || '')
    .replace(/[|·—–\-:：]\s*[^|·—–\-:：]*$/, '')
    .replace(/^\s*[^|·—–\-:：]{0,18}[|·—–\-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.split(' ').slice(0, 6).join(' ') || (title || '').slice(0, 24)
}

// ---------------------------------------------------------------------------
// Rules (Timing Filter: AND-condition group -> project, ordered, first match wins)
// ---------------------------------------------------------------------------

interface RuleRow {
  id: number
  project_id: number
  conditions_json: string
  list_position: number
}

/** Normalize stored JSON into a RuleNode; legacy flat condition arrays become an 'all' group. */
function normalizeNode(raw: unknown): RuleNode {
  if (Array.isArray(raw)) {
    return { kind: 'all', children: raw.map((c) => condToNode(c)).filter((n): n is RuleNode => n !== null) }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.kind === 'cond') return condToNode(o) ?? { kind: 'all', children: [] }
    if (o.kind === 'not') return { kind: 'not', child: normalizeNode(o.child) }
    if (o.kind === 'any' || o.kind === 'all') {
      return { kind: o.kind, children: Array.isArray(o.children) ? o.children.map(normalizeNode) : [] }
    }
  }
  return { kind: 'all', children: [] }
}

function condToNode(c: unknown): RuleNode | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  if (typeof o.field === 'string' && typeof o.op === 'string' && typeof o.value === 'string') {
    return { kind: 'cond', field: o.field as RuleCondition['field'], op: o.op as RuleCondition['op'], value: o.value }
  }
  return null
}

function rowToRule(r: RuleRow): Rule {
  let conditions: RuleNode
  try {
    conditions = normalizeNode(JSON.parse(r.conditions_json))
  } catch {
    conditions = { kind: 'all', children: [] }
  }
  return { id: r.id, projectId: r.project_id, conditions, listPosition: r.list_position }
}

export function listRules(): Rule[] {
  return db
    .all<RuleRow>('SELECT * FROM rules WHERE is_deleted = 0 ORDER BY list_position, id')
    .map(rowToRule)
}

export function createRule(projectId: number, conditions: RuleCondition[] | RuleNode): Rule {
  const pos = db.count('SELECT COUNT(*) AS c FROM rules WHERE is_deleted = 0') + 1
  db.run('INSERT INTO rules (project_id, conditions_json, list_position) VALUES (?, ?, ?)', [
    projectId,
    JSON.stringify(Array.isArray(conditions) ? { kind: 'all', children: conditions.map(condToNode).filter(Boolean) } : conditions),
    pos
  ])
  const id = (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 }).id
  return listRules().find((r) => r.id === id)!
}

export function deleteRule(id: number): void {
  db.run('UPDATE rules SET is_deleted = 1 WHERE id = ?', [id])
}

/** Apply a new rule retroactively to matching unclassified history. */
export function applyRuleRetroactively(rule: Rule): number {
  const rows = db.all<{ id: number; app_name: string; title: string; url_or_path: string | null }>(
    `SELECT id, app_name, title, url_or_path FROM app_activities
     WHERE is_deleted = 0 AND (project_id IS NULL OR is_manual = 0)`
  )
  let n = 0
  for (const r of rows) {
    if (evalConditions(rule.conditions, r.app_name, r.title ?? '', r.url_or_path)) {
      db.run('UPDATE app_activities SET project_id = ?, is_manual = 0 WHERE id = ?', [rule.projectId, r.id])
      n++
    }
  }
  return n
}

function evalNode(node: RuleNode, app: string, title: string, urlOrPath: string | null): boolean {
  switch (node.kind) {
    case 'cond':
      return evalCondition(node, app, title, urlOrPath)
    case 'all':
      return node.children.length > 0 && node.children.every((n) => evalNode(n, app, title, urlOrPath))
    case 'any':
      return node.children.some((n) => evalNode(n, app, title, urlOrPath))
    case 'not':
      return !evalNode(node.child, app, title, urlOrPath)
  }
}

function evalCondition(c: RuleCondition, app: string, title: string, urlOrPath: string | null): boolean {
  const target = c.field === 'app' ? app : c.field === 'title' ? title : (urlOrPath ?? '')
  const value = c.value.trim()
  if (value.length === 0) return false
  switch (c.op) {
    case 'contains':
      return target.toLowerCase().includes(value.toLowerCase())
    case 'equals':
      return target.toLowerCase() === value.toLowerCase()
    case 'startsWith':
      return target.toLowerCase().startsWith(value.toLowerCase())
    case 'regex':
      try {
        return new RegExp(value, 'i').test(target)
      } catch {
        return false
      }
    default:
      return false
  }
}

function evalConditions(conditions: RuleNode, app: string, title: string, urlOrPath: string | null): boolean {
  return evalNode(conditions, app, title, urlOrPath)
}

export type ClassifySource = 'rule' | 'learned-title' | 'site-hint' | 'learned-app'

export interface ClassifyMatch {
  projectId: number
  source: ClassifySource
  /** 可读匹配依据(规则条件摘要/标题模式/站点名/应用名),供强打断面板展示。 */
  matched: string
}

const FIELD_LABEL: Record<string, string> = { app: '应用', title: '标题', urlOrPath: '网址/路径' }
const OP_LABEL: Record<string, string> = { contains: '含', equals: '=', startsWith: '以…开头', regex: '正则' }

function summarizeNode(n: RuleNode): string {
  const walk = (x: RuleNode): string[] => {
    if (x.kind === 'cond') {
      const field = FIELD_LABEL[x.field] ?? String(x.field)
      const op = OP_LABEL[x.op] ?? x.op
      return [`${field}${op}"${x.value}"`]
    }
    if (x.kind === 'not') return walk(x.child)
    return x.children.flatMap(walk)
  }
  return walk(n).slice(0, 3).join(' · ')
}

/** 带依据的分类:强打断面板要显示"匹配到什么才遮蔽"。 */
export function classifyActivityDetail(
  appName: string,
  title: string,
  urlOrPath: string | null = null
): ClassifyMatch | null {
  const rules = listRules()
  for (const rule of rules) {
    if (evalConditions(rule.conditions, appName, title, urlOrPath)) {
      return { projectId: rule.projectId, source: 'rule', matched: summarizeNode(rule.conditions) }
    }
  }
  // Title-level learned classification (browsers are classified by page, not exe).
  if (isBrowserApp(appName)) {
    const pattern = titlePattern(title)
    const titleLevel = db.get<{ project_id: number }>(
      `SELECT project_id FROM classifications WHERE app_name = ? AND title_pattern = ? LIMIT 1`,
      [appName, pattern]
    )
    if (titleLevel) return { projectId: titleLevel.project_id, source: 'learned-title', matched: `标题模式"${pattern}"` }
    // Site hints give an instant verdict for well-known pages.
    const hint = siteHintProject(title)
    if (hint) {
      const proj = listProjects().find((p) => p.title === hint)
      if (proj) {
        db.run(
          `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(app_name, title_pattern) DO UPDATE SET project_id = excluded.project_id`,
          [appName, pattern, proj.id, Date.now()]
        )
        return { projectId: proj.id, source: 'site-hint', matched: `站点"${hint}"` }
      }
    }
    return null
  }
  // App-level learned classification (manual history or LLM verdict).
  const appLevel = db.get<{ project_id: number }>(
    `SELECT project_id FROM classifications WHERE app_name = ? AND title_pattern = '*' LIMIT 1`,
    [appName]
  )
  if (appLevel) return { projectId: appLevel.project_id, source: 'learned-app', matched: `应用"${appName}"` }
  return null
}

/** Classify an activity through the rule engine (first matching rule wins). */
export function classifyActivity(appName: string, title: string, urlOrPath: string | null = null): number | null {
  return classifyActivityDetail(appName, title, urlOrPath)?.projectId ?? null
}

/** Has this app ever been seen (any activity or classification)? */
export function isKnownApp(appName: string): boolean {
  const seen = db.count('SELECT COUNT(*) AS c FROM app_activities WHERE app_name = ?', [appName])
  const classified = db.count(
    `SELECT COUNT(*) AS c FROM classifications WHERE app_name = ? AND title_pattern = '*'`,
    [appName]
  )
  return seen > 1 || classified > 0
}

/** Store an app-level classification (used for LLM verdicts). */
export function setAppClassification(appName: string, projectId: number): void {
  db.run(
    `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
     VALUES (?, '*', ?, 1, ?)
     ON CONFLICT(app_name, title_pattern) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`,
    [appName, projectId, Date.now()]
  )
}

// ---------------------------------------------------------------------------
// Suggestions (Timing: TaskActivitySuggestionRanker by provenance metadata)
// ---------------------------------------------------------------------------

export function getSuggestion(appName: string, titlePatternStr: string): ProjectSuggestion | null {
  const row = db.get<{
    app_name: string
    title_pattern: string
    project_id: number
    hits: number
  }>(
    `SELECT * FROM classifications WHERE app_name = ? AND title_pattern = ? ORDER BY hits DESC LIMIT 1`,
    [appName, titlePatternStr]
  )
  if (!row) return null
  const proj = listProjects().find((p) => p.id === row.project_id)
  if (!proj) return null
  return {
    appName: row.app_name,
    titlePattern: row.title_pattern,
    projectId: proj.id,
    hits: row.hits,
    projectTitle: proj.title,
    projectColor: proj.color
  }
}

/** Review page: unclassified (app, title-bucket) groups ranked by total minutes. */
export function unclassifiedGroups(limit = 30): RuleSuggestionItem[] {
  const rows = db.all<{ app_name: string; title: string; ms: number }>(
    `SELECT app_name, title, SUM(end_ts - start_ts) AS ms
     FROM app_activities
     WHERE is_deleted = 0 AND project_id IS NULL
     GROUP BY app_name, title
     ORDER BY ms DESC
     LIMIT ?`,
    [limit * 3]
  )
  const byPattern = new Map<string, RuleSuggestionItem>()
  for (const r of rows) {
    const pattern = coarsePattern(r.title ?? '')
    const key = `${r.app_name}\u0000${pattern}`
    const existing = byPattern.get(key)
    if (existing) {
      existing.totalMinutes += Math.round(r.ms / 60000)
    } else {
      byPattern.set(key, {
        appName: r.app_name,
        titlePattern: pattern,
        totalMinutes: Math.round(r.ms / 60000),
        suggestion: getSuggestion(r.app_name, pattern)
      })
    }
  }
  return [...byPattern.values()].sort((a, b) => b.totalMinutes - a.totalMinutes).slice(0, limit)
}

function coarsePattern(title: string): string {
  const clean = (title || '')
    .replace(/[|·—–\-:：]\s*[^|·—–\-:：]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.split(' ').slice(0, 4).join(' ') || clean.slice(0, 24)
}

// ---------------------------------------------------------------------------
// Project management: merge / stats overview / learned classification maps
// ---------------------------------------------------------------------------

function isDescendant(projectId: number, maybeAncestor: number): boolean {
  const all = listProjects()
  let cur = all.find((p) => p.id === projectId)
  while (cur && cur.parentId !== null) {
    if (cur.parentId === maybeAncestor) return true
    cur = all.find((p) => p.id === cur!.parentId)
  }
  return false
}

/** 合并项目：活动/任务/规则/归类映射/子项目全部移入目标项目，源项目删除。 */
export function mergeProjects(sourceId: number, targetId: number): void {
  if (sourceId === targetId) return
  const source = listProjects().find((p) => p.id === sourceId)
  if (!source) return
  // 目标是源的后代时先把目标提为源的兄弟，避免父子成环。
  if (isDescendant(targetId, sourceId)) {
    db.run('UPDATE projects SET parent_id = ? WHERE id = ?', [source.parentId, targetId])
  }
  db.runMany([
    { sql: 'UPDATE app_activities SET project_id = ? WHERE project_id = ?', params: [targetId, sourceId] },
    { sql: 'UPDATE task_activities SET project_id = ? WHERE project_id = ?', params: [targetId, sourceId] },
    { sql: 'UPDATE rules SET project_id = ? WHERE project_id = ?', params: [targetId, sourceId] },
    { sql: 'UPDATE classifications SET project_id = ? WHERE project_id = ?', params: [targetId, sourceId] },
    { sql: 'UPDATE projects SET parent_id = ? WHERE parent_id = ?', params: [targetId, sourceId] },
    { sql: 'UPDATE projects SET is_deleted = 1 WHERE id = ?', params: [sourceId] }
  ])
}

/** 项目管理页统计：今天 / 近 7 天 / 近 30 天时长 + 段数 + 头部应用。 */
export function projectsOverview(): ProjectsOverview {
  const todayStart = dayStartTs(todayKey())
  const weekStart = todayStart - 6 * 86400_000
  const monthStart = todayStart - 29 * 86400_000

  const rangeMinutes = (since: number): Map<number | null, number> => {
    const rows = db.all<{ project_id: number | null; ms: number }>(
      `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
       WHERE is_deleted = 0 AND start_ts >= ? GROUP BY project_id`,
      [since]
    )
    const m = new Map<number | null, number>()
    for (const r of rows) m.set(r.project_id, Math.round(r.ms / 60000))
    const taskRows = db.all<{ project_id: number | null; ms: number }>(
      `SELECT project_id, SUM(COALESCE(end_ts, ?) - start_ts) AS ms FROM task_activities
       WHERE is_deleted = 0 AND start_ts >= ? GROUP BY project_id`,
      [Date.now(), since]
    )
    for (const r of taskRows) m.set(r.project_id, (m.get(r.project_id) ?? 0) + Math.round(r.ms / 60000))
    return m
  }

  const todayMap = rangeMinutes(todayStart)
  const weekMap = rangeMinutes(weekStart)
  const monthMap = rangeMinutes(monthStart)

  const segRows = db.all<{ project_id: number | null; app_name: string; ms: number; segs: number }>(
    `SELECT project_id, app_name, SUM(end_ts - start_ts) AS ms, COUNT(*) AS segs
     FROM app_activities WHERE is_deleted = 0 AND start_ts >= ?
     GROUP BY project_id, app_name`,
    [monthStart]
  )
  const stats = new Map<number, ProjectStats>()
  const ensure = (pid: number): ProjectStats => {
    let s = stats.get(pid)
    if (!s) {
      s = { projectId: pid, todayMin: 0, weekMin: 0, monthMin: 0, segments: 0, topApps: [] }
      stats.set(pid, s)
    }
    return s
  }
  const appMap = new Map<number, { app: string; minutes: number }[]>()
  for (const r of segRows) {
    if (r.project_id === null) continue
    const s = ensure(r.project_id)
    s.segments += r.segs
    const list = appMap.get(r.project_id) ?? []
    list.push({ app: r.app_name, minutes: Math.round(r.ms / 60000) })
    appMap.set(r.project_id, list)
  }
  for (const [pid, s] of stats) {
    s.todayMin = todayMap.get(pid) ?? 0
    s.weekMin = weekMap.get(pid) ?? 0
    s.monthMin = monthMap.get(pid) ?? 0
    s.topApps = (appMap.get(pid) ?? []).sort((a, b) => b.minutes - a.minutes).slice(0, 5)
  }

  // 效率指数：近 30 天分钟数（子项目滚动到祖先）按 productivityScore 加权。
  const projects = listProjects()
  const rolled = new Map<number, number>()
  for (const p of projects) rolled.set(p.id, monthMap.get(p.id) ?? 0)
  const sorted = [...projects].sort((a, b) => a.listPosition - b.listPosition)
  for (let pass = 0; pass < 5; pass++) {
    for (const p of sorted) {
      if (p.parentId !== null && rolled.has(p.parentId)) {
        rolled.set(p.parentId, (rolled.get(p.parentId) ?? 0) + (rolled.get(p.id) ?? 0))
      }
    }
  }
  let scoredMs = 0
  let weighted = 0
  for (const p of projects) {
    const ms = rolled.get(p.id) ?? 0
    if (p.productivityScore !== 0 && ms > 0) {
      scoredMs += ms
      weighted += ms * p.productivityScore
    }
  }

  return {
    stats: [...stats.values()],
    unclassifiedMin: {
      today: todayMap.get(null) ?? 0,
      week: weekMap.get(null) ?? 0,
      month: monthMap.get(null) ?? 0
    },
    productivityIndex: scoredMs > 0 ? Math.round(weighted / scoredMs) : null
  }
}

export function listClassifications(): ClassificationEntry[] {
  return db
    .all<{ app_name: string; title_pattern: string; project_id: number; hits: number; updated_at: number }>(
      'SELECT * FROM classifications ORDER BY hits DESC, updated_at DESC'
    )
    .map((r) => ({
      appName: r.app_name,
      titlePattern: r.title_pattern,
      projectId: r.project_id,
      hits: r.hits,
      updatedAt: r.updated_at
    }))
}

export function deleteClassification(appName: string, titlePattern: string): void {
  db.run('DELETE FROM classifications WHERE app_name = ? AND title_pattern = ?', [appName, titlePattern])
}
