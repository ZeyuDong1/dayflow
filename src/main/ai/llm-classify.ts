import { db } from '../db'
import {
  listProjects,
  setAppClassification,
  isKnownApp,
  isBrowserApp,
  titlePattern
} from '../projects'
import { textComplete, resolveProvider, extractJsonObject } from './providers'

/**
 * When a process appears for the first time, ask the LLM (cheap text call)
 * which project it belongs to and remember the verdict at the app level.
 * Browsers are EXCLUDED: they are classified per page title, never by exe.
 */

const pending = new Set<string>()
const titlePending = new Set<string>()
let lastTitleCallAt = 0

export function classifyNewAppIfNeeded(appName: string, sampleTitle: string): void {
  if (pending.has(appName)) return
  if (isBrowserApp(appName)) return // browsers: page-level, see classifyBrowserTitleIfNeeded
  if (isKnownApp(appName)) return
  if (!resolveProvider().ready) return
  pending.add(appName)
  void classifyAppWithLLM(appName, sampleTitle)
    .then((projectId) => {
      if (projectId !== null) {
        setAppClassification(appName, projectId)
        console.log(`[llm-classify] ${appName} -> project #${projectId}`)
      } else {
        console.log(`[llm-classify] ${appName} -> undecided (left unclassified)`)
      }
    })
    .catch((err) => {
      console.warn(`[llm-classify] ${appName} failed:`, err instanceof Error ? err.message : err)
    })
    .finally(() => pending.delete(appName))
}

/**
 * Browsers: classify an unseen page-title bucket with the LLM. Throttled to
 * one call per 20s so heavy tab-switching doesn't spam the provider.
 */
export function classifyBrowserTitleIfNeeded(appName: string, title: string): void {
  if (!isBrowserApp(appName)) return
  if (!resolveProvider().ready) return
  const pattern = titlePattern(title)
  const key = `${appName}\u0000${pattern}`
  if (titlePending.has(key)) return
  const known = db.count(
    'SELECT COUNT(*) AS c FROM classifications WHERE app_name = ? AND title_pattern = ?',
    [appName, pattern]
  )
  if (known > 0) return
  const now = Date.now()
  if (now - lastTitleCallAt < 20_000) return
  lastTitleCallAt = now
  titlePending.add(key)
  void classifyTitleWithLLM(appName, pattern, title)
    .then((projectId) => {
      if (projectId !== null) {
        db.run(
          `INSERT INTO classifications (app_name, title_pattern, project_id, hits, updated_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(app_name, title_pattern) DO UPDATE SET project_id = excluded.project_id`,
          [appName, pattern, projectId, Date.now()]
        )
        // Future segments with this title bucket get classified on close.
        console.log(`[llm-classify] ${appName} 「${pattern.slice(0, 30)}」 -> project #${projectId}`)
      }
    })
    .catch((err) => {
      console.warn(`[llm-classify] title "${pattern.slice(0, 30)}" failed:`, err instanceof Error ? err.message : err)
    })
    .finally(() => titlePending.delete(key))
}

async function classifyTitleWithLLM(appName: string, pattern: string, fullTitle: string): Promise<number | null> {
  const projects = listProjects()
  if (projects.length === 0) return null
  const prompt = `你是一个时间追踪应用的分类助手。用户在浏览器里打开了网页，请根据页面标题判断这属于哪个项目。

项目列表:
${projects.map((p) => `- ${p.title}`).join('\n')}

浏览器: ${appName}
页面标题: "${fullTitle.slice(0, 160)}"

只输出 JSON: {"projectId": null, "confidence": 0, "reason": ""}
（projectId 用项目标题对应含义的整数 id；标题无法判断时 projectId 为 null，confidence 低于 0.6 也用 null）`
  const raw = await textComplete(prompt, 'title-classify')
  let parsed: { projectId?: number | null; confidence?: number }
  try {
    parsed = extractJsonObject<{ projectId?: number | null; confidence?: number }>(raw)
  } catch {
    return null
  }
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
  if (parsed.projectId === null || parsed.projectId === undefined || confidence < 0.6) return null
  const id = Number(parsed.projectId)
  return projects.some((p) => p.id === id) ? id : null
}

async function classifyAppWithLLM(appName: string, sampleTitle: string): Promise<number | null> {
  const projects = listProjects()
  if (projects.length === 0) return null
  const list = projects
    .map((p) => `- id=${p.id}: ${p.title}`)
    .join('\n')
  const prompt = `你是一个 Windows 时间追踪应用的项目归类助手。用户的现有项目列表：

${list}

一个应用第一次被检测到，请判断它最可能属于哪个项目。
应用进程名: "${appName}"
窗口标题示例: "${sampleTitle.slice(0, 120)}"

常见例子供参考: Code.exe/idea64.exe→编码开发; WINWORD.EXE/Notion→文档写作; Photoshop.exe/Figma→设计创作; WeChat/钉钉/Slack/Teams→沟通交流; 浏览器要结合标题内容判断（技术文档→调研学习，购物/新闻→网页浏览，视频站→娱乐消遣）; 游戏和播放器→娱乐消遣; explorer.exe/设置→系统与工具。

只输出 JSON（不要多余文字）：
{"projectId": <上面列表中的 id 或 null>, "confidence": <0到1的小数>, "reason": "<10字以内理由>"}
不确定（confidence < 0.6）时 projectId 用 null。`

  const raw = await textComplete(prompt, 'app-classify')
  let parsed: { projectId?: number | null; confidence?: number; reason?: string }
  try {
    parsed = extractJsonObject<{ projectId?: number | null; confidence?: number }>(raw)
  } catch {
    return null
  }
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
  if (parsed.projectId === null || parsed.projectId === undefined) return null
  if (confidence < 0.6) return null
  const id = Number(parsed.projectId)
  if (!projects.some((p) => p.id === id)) return null
  return id
}

/** Retroactively classify apps that appeared while no provider was configured. */
export function classifyBacklogApps(): void {
  if (!resolveProvider().ready) return
  const rows = db.all<{ app_name: string; title: string }>(
    `SELECT app_name, MAX(title) AS title FROM app_activities
     WHERE is_deleted = 0
     GROUP BY app_name
     ORDER BY MAX(end_ts) DESC
     LIMIT 40`
  )
  for (const r of rows) {
    classifyNewAppIfNeeded(r.app_name, r.title ?? '')
  }
}
