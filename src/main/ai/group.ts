import { db } from '../db'
import { listProjects, titlePattern } from '../projects'
import { textComplete, resolveProvider, extractJsonObject } from './providers'

/**
 * Timing-style AI review: cluster unclassified activities into meaningful
 * themed groups and suggest a project for each, so a few clicks clean up
 * a whole week of untracked time.
 */

export interface GroupItem {
  appName: string
  titlePattern: string
  totalMinutes: number
}

export interface AiGroup {
  name: string
  reason: string
  projectId: number | null
  projectTitle: string | null
  items: GroupItem[]
  totalMinutes: number
}

/** Unclassified (app, title-bucket) items across the last N days (input for grouping). */
function unclassifiedItems(days = 7): GroupItem[] {
  const since = Date.now() - days * 86400_000
  const rows = db.all<{ app_name: string; title: string; ms: number }>(
    `SELECT app_name, title, SUM(end_ts - start_ts) AS ms
     FROM app_activities
     WHERE is_deleted = 0 AND is_idle = 0 AND project_id IS NULL AND start_ts >= ?
     GROUP BY app_name, title
     ORDER BY ms DESC
     LIMIT 120`,
    [since]
  )
  const byPattern = new Map<string, GroupItem>()
  for (const r of rows) {
    const pattern = titlePattern(r.title ?? '')
    const key = `${r.app_name}\u0000${pattern}`
    const existing = byPattern.get(key)
    const min = Math.round(r.ms / 60000)
    if (existing) {
      existing.totalMinutes += min
    } else {
      byPattern.set(key, { appName: r.app_name, titlePattern: pattern, totalMinutes: min })
    }
  }
  return [...byPattern.values()].sort((a, b) => b.totalMinutes - a.totalMinutes).slice(0, 60)
}

export async function aiGroupUnclassified(days = 7): Promise<AiGroup[]> {
  const items = unclassifiedItems(days)
  if (items.length === 0) return []
  if (!resolveProvider().ready) throw new Error('请先在设置中配置 AI 提供商')

  const projects = listProjects()
  const list = items
    .map((it, i) => `${i + 1}. [${it.appName}] 「${it.titlePattern.slice(0, 50)}」 ${it.totalMinutes} 分钟`)
    .join('\n')
  const prompt = `你是时间追踪应用的整理助手。以下是用户最近 ${days} 天的未归类活动（应用 + 窗口标题模式 + 总分钟数）：

${list}

项目列表:
${projects.map((p) => `- id=${p.id}: ${p.title}`).join('\n')}

请把这些活动聚成 3~8 个有意义的主题组（比如"Warframe 游戏与攻略查询"、"AI 编程助手使用"、"碎片化社交浏览"），每个组：
- name: 简短主题名（中文）
- items: 属于该组的活动序号数组
- projectId: 最匹配的项目 id（必须从列表选）；确实没有合适项目时用 null
- reason: 一句话理由

每个活动最多属于一个组；总时长过小（<10分钟）的零散项可以不分组。只输出 JSON：
{"groups":[{"name":"","items":[1,2],"projectId":1,"reason":""}]}`

  const raw = await textComplete(prompt, 'ai-group')
  const parsed = extractJsonObject<{ groups?: { name?: string; items?: unknown; projectId?: number | null; reason?: string }[] }>(raw)
  const groups: AiGroup[] = []
  for (const g of parsed.groups ?? []) {
    const idxs = Array.isArray(g.items)
      ? g.items.map((x) => Number(x) - 1).filter((x) => x >= 0 && x < items.length)
      : []
    if (idxs.length === 0) continue
    const groupItems = idxs.map((i) => items[i])
    const projectId = g.projectId !== null && g.projectId !== undefined && projects.some((p) => p.id === Number(g.projectId))
      ? Number(g.projectId)
      : null
    groups.push({
      name: (g.name ?? '未命名组').slice(0, 40),
      reason: (g.reason ?? '').slice(0, 80),
      projectId,
      projectTitle: projectId !== null ? projects.find((p) => p.id === projectId)?.title ?? null : null,
      items: groupItems,
      totalMinutes: groupItems.reduce((a, x) => a + x.totalMinutes, 0)
    })
  }
  return groups
}

/** Apply a group: bulk-assign every item in it to the chosen project. */
export function applyAiGroup(group: AiGroup, projectId: number): number {
  let n = 0
  for (const it of group.items) {
    const rows = db.all<{ id: number; title: string }>(
      `SELECT id, title FROM app_activities
       WHERE is_deleted = 0 AND app_name = ? AND (project_id IS NULL OR is_manual = 0)`,
      [it.appName]
    )
    for (const r of rows) {
      const pat = titlePattern(r.title ?? '')
      if (pat === it.titlePattern || pat.startsWith(it.titlePattern) || (r.title ?? '').includes(it.titlePattern)) {
        db.run('UPDATE app_activities SET project_id = ?, is_manual = 1 WHERE id = ?', [projectId, r.id])
        n++
      }
    }
    db.run(
      `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(app_name, title_pattern) DO UPDATE SET project_id = excluded.project_id, hits = hits + 1, updated_at = excluded.updated_at`,
      [it.appName, it.titlePattern, projectId, Date.now()]
    )
  }
  return n
}
