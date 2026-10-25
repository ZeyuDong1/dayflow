import {
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  app,
  nativeImage
} from 'electron'
import fs from 'fs'
import { db } from './db'
import {
  getSettings,
  saveSettings,
  isOnboarded,
  markOnboarded
} from './settings'
import * as projectsMod from './projects'
import { classifyBacklogApps } from './ai/llm-classify'
import * as groupMod from './ai/group'
import { getAppIcons } from './app-icons'
import * as windowsPoll from './windows-poll'
import * as tasksMod from './tasks'
import type { Project, RuleCondition, RuleNode } from '../shared/types'
import {
  getCardsForDay,
  deleteCard,
  deleteDay,
  reprocessDay,
  forceFlushPending,
  getLastPipelineError
} from './ai/analyze'
import { getStandup, generateStandup, getDayPlan, saveDayPlan } from './ai/standup'
import { buildWeeklyReview, buildDaySummary, weekStartFor } from './weekly'
import { listModels, testConnection } from './ai/providers'
import { memoryServerInfo, startMemoryServer } from './memory/sidecar'
import { memoryQuery, memoryWritePage, MEM_GOAL } from './memory/client'
import { reflectNow, restartReflectionLoop } from './ai/reflect-tick'
import * as chat from './ai/chat'
import { exportMarkdown } from './exporter'
import { getStorageUsage, runCleanup, deleteAllData } from './cleanup'
import { countPendingScreenshots, restartCapture } from './capture'
import { dayEndTs, dayStartTs, todayKey } from './paths'
import type { AppSettings, DeepPartial, DayPlan, TimelineCard } from '../shared/types'

export function registerIpc(win: BrowserWindow): void {
  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // -- Settings ----------------------------------------------------------
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: DeepPartial<AppSettings>) => {
    const next = saveSettings(patch)
    if (patch.capture) restartCapture()
    if (patch.ai) classifyBacklogApps()
    if (patch.tutor) restartReflectionLoop()
    // 学习目标写穿到长期记忆,保持设置与记忆一致
    if (patch.tutor && patch.tutor.goal !== undefined) {
      void memoryWritePage(MEM_GOAL, `# 学习目标\n${patch.tutor.goal.trim() || '（未设定）'}`, '学习目标').catch(() => {})
    }
    return next
  })

  ipcMain.handle('onboarded:get', () => isOnboarded())
  ipcMain.handle('onboard:complete', () => {
    markOnboarded()
    return true
  })

  // -- Capture -----------------------------------------------------------
  ipcMain.handle('capture:status', () => {
    const settings = getSettings()
    return {
      enabled: settings.capture.enabled,
      pausedUntil: settings.capture.pauseUntil,
      intervalSec: settings.capture.intervalSec
    }
  })
  ipcMain.handle('capture:pause', (_e, minutes: number) => {
    const until = minutes > 0 ? Date.now() + minutes * 60_000 : Date.now() + 8 * 60 * 60_000
    saveSettings({ capture: { pauseUntil: until } })
    restartCapture()
    return until
  })
  ipcMain.handle('capture:resume', () => {
    saveSettings({ capture: { pauseUntil: null } })
    restartCapture()
    return true
  })

  // -- Timeline ----------------------------------------------------------
  ipcMain.handle('timeline:day', (_e, day: string) => {
    const cards = getCardsForDay(day)
    const summary = buildDaySummary(day)
    const start = dayStartTs(day)
    const end = dayEndTs(day)
    const pending = db.count(
      `SELECT COUNT(*) AS c FROM screenshots s
       WHERE s.is_deleted = 0 AND s.captured_at >= ? AND s.captured_at < ?
         AND NOT EXISTS (SELECT 1 FROM batch_screenshots bs WHERE bs.screenshot_id = s.id)`,
      [start, end]
    )
    return { cards, summary, pending, pipelineError: getLastPipelineError() }
  })
  ipcMain.handle('timeline:today', () => todayKey())
  ipcMain.handle('timeline:deleteCard', (_e, id: number) => {
    deleteCard(id)
    return true
  })
  ipcMain.handle('timeline:deleteDay', (_e, day: string) => {
    deleteDay(day)
    return true
  })
  ipcMain.handle('timeline:reprocessDay', (_e, day: string) => reprocessDay(day))
  ipcMain.handle('timeline:forceFlush', () => {
    forceFlushPending()
    return true
  })

  ipcMain.handle('screenshots:forCard', (_e, card: TimelineCard, max = 10) => {
    const rows = db.all<{ id: number; captured_at: number; file_path: string }>(
      `SELECT s.id, s.captured_at, s.file_path FROM screenshots s
       JOIN batch_screenshots bs ON bs.screenshot_id = s.id
       JOIN analysis_batches ab ON ab.id = bs.batch_id
       WHERE s.is_deleted = 0 AND ab.batch_start_ts < ? AND ab.batch_end_ts > ?
       ORDER BY s.captured_at ASC`,
      [card.endTs, card.startTs]
    )
    const step = Math.max(1, Math.floor(rows.length / max))
    const sampled: typeof rows = []
    for (let i = 0; i < rows.length && sampled.length < max; i += step) sampled.push(rows[i])
    return sampled
      .map((r) => {
        try {
          const buf = fs.readFileSync(r.file_path)
          const img = nativeImage.createFromBuffer(buf)
          const size = img.getSize()
          const scaled = size.width > 640 ? img.resize({ width: 640 }) : img
          const jpeg = scaled.toJPEG(70)
          return {
            id: r.id,
            capturedAt: r.captured_at,
            dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`
          }
        } catch {
          return null
        }
      })
      .filter((x): x is { id: number; capturedAt: number; dataUrl: string } => x !== null)
  })

  // -- Standup & daily -----------------------------------------------------
  ipcMain.handle('standup:get', (_e, day: string) => getStandup(day))
  ipcMain.handle('standup:generate', async (_e, day: string) => {
    try {
      return { ok: true, payload: await generateStandup(day) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('plan:get', (_e, day: string) => getDayPlan(day))
  ipcMain.handle('plan:save', (_e, plan: DayPlan) => {
    saveDayPlan(plan)
    return true
  })

  // -- Weekly --------------------------------------------------------------
  ipcMain.handle('weekly:get', (_e, dayInWeek: string) => buildWeeklyReview(weekStartFor(dayInWeek)))

  // -- Chat ----------------------------------------------------------------
  ipcMain.handle('chat:conversations', () => chat.listConversations())
  ipcMain.handle('chat:new', (_e, title: string) => chat.createConversation(title))
  ipcMain.handle('chat:messages', (_e, id: string) => chat.getMessages(id))
  ipcMain.handle('chat:delete', (_e, id: string) => {
    chat.deleteConversation(id)
    return true
  })
  ipcMain.handle('chat:abort', (_e, id: string) => {
    chat.abortChat(id)
    return true
  })
  ipcMain.handle('chat:send', async (_e, id: string, question: string) => {
    await chat.sendChat(win, id, question, {
      onToken: (delta) => send('chat:event', { conversationId: id, type: 'token', delta }),
      onDone: (full) => send('chat:event', { conversationId: id, type: 'done', full }),
      onError: (message) => send('chat:event', { conversationId: id, type: 'error', message })
    })
    return true
  })

  // -- AI admin --------------------------------------------------------------
  ipcMain.handle('ai:test', async () => testConnection())
  ipcMain.handle('ai:models', async (_e, provider: string) => listModels(provider as never))

  // -- 学习导师（记忆侧车 + 反思） ---------------------------------------------
  ipcMain.handle('tutor:status', () => memoryServerInfo())
  ipcMain.handle('tutor:startMemory', () => startMemoryServer())
  ipcMain.handle('tutor:reflectNow', () => reflectNow())
  ipcMain.handle('tutor:searchMemory', (_e, query: string) => memoryQuery(query, 8))

  // -- Export ------------------------------------------------------------------
  ipcMain.handle('export:markdown', async (_e, start: string, end: string) => exportMarkdown(start, end))

  // -- Storage -----------------------------------------------------------------
  ipcMain.handle('storage:usage', () => getStorageUsage())
  ipcMain.handle('storage:cleanupNow', () => {
    runCleanup()
    return getStorageUsage()
  })
  ipcMain.handle('storage:deleteAll', async () => {
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Delete all data',
      message: 'Delete ALL recordings, screenshots, timeline cards, standups and chat history?',
      detail: 'This cannot be undone. Your settings are kept.',
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (result.response !== 0) return { ok: false, message: 'Cancelled.' }
    deleteAllData()
    return { ok: true, message: 'All data deleted.' }
  })

  // -- Misc --------------------------------------------------------------------
  ipcMain.handle('app:openRecordings', () => {
    void shell.openPath(app.getPath('userData'))
    return true
  })
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:pendingCount', () => countPendingScreenshots())
  ipcMain.handle('apps:icons', (_e, names: string[]) => getAppIcons(names))

  // -- Timing-style: projects / rules / activities / tasks ----------------------
  ipcMain.handle('projects:list', () => projectsMod.listProjects())
  ipcMain.handle('projects:create', (_e, input: { title: string; parentId?: number | null; color?: string; productivityScore?: number; billableByDefault?: boolean }) =>
    projectsMod.createProject(input)
  )
  ipcMain.handle('projects:update', (_e, id: number, patch: Partial<Project>) => {
    projectsMod.updateProject(id, patch)
    return projectsMod.listProjects()
  })
  ipcMain.handle('projects:delete', (_e, id: number) => {
    projectsMod.deleteProject(id)
    return projectsMod.listProjects()
  })

  ipcMain.handle('rules:list', () => projectsMod.listRules())
  ipcMain.handle('rules:create', (_e, projectId: number, conditions: RuleCondition[] | RuleNode) => {
    const rule = projectsMod.createRule(projectId, conditions)
    const applied = projectsMod.applyRuleRetroactively(rule)
    return { rule, appliedCount: applied }
  })
  ipcMain.handle('rules:delete', (_e, id: number) => {
    projectsMod.deleteRule(id)
    return projectsMod.listRules()
  })

  ipcMain.handle('activities:day', (_e, day: string) => windowsPoll.getActivitiesForDay(day))
  ipcMain.handle('activities:assign', (_e, activityId: number, projectId: number | null) => {
    windowsPoll.assignActivityProject(activityId, projectId, true)
    return true
  })
  ipcMain.handle('activities:bulkAssign', (_e, appName: string, pattern: string, projectId: number) =>
    windowsPoll.bulkAssign(appName, pattern, projectId)
  )
  ipcMain.handle('review:unclassified', () => projectsMod.unclassifiedGroups())
  ipcMain.handle('review:aiGroup', async (_e, days = 7) => {
    try {
      return { ok: true, groups: await groupMod.aiGroupUnclassified(days) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('review:applyGroup', (_e, group: groupMod.AiGroup, projectId: number) =>
    groupMod.applyAiGroup(group, projectId)
  )

  ipcMain.handle('tasks:range', (_e, startTs: number, endTs: number) => tasksMod.listTasks(startTs, endTs))
  ipcMain.handle('tasks:start', (_e, title: string, projectId: number | null, billable: boolean) =>
    tasksMod.startTask(title, projectId, billable)
  )
  ipcMain.handle('tasks:stop', () => tasksMod.stopTask())
  ipcMain.handle('tasks:running', () => tasksMod.getRunningTask())
  ipcMain.handle('tasks:create', (_e, startTs: number, endTs: number, title: string, projectId: number | null, billable: boolean) => {
    tasksMod.createManualTask(startTs, endTs, title, projectId, billable)
    return true
  })
  ipcMain.handle('tasks:delete', (_e, id: number) => {
    tasksMod.deleteTask(id)
    return true
  })

  // -- Reports (project stats + timesheet CSV) -----------------------------------
  ipcMain.handle('report:projectStats', (_e, startDay: string, endDay: string) => {
    const [sy, sm, sd] = startDay.split('-').map(Number)
    const [ey, em, ed] = endDay.split('-').map(Number)
    const startTs = new Date(sy, sm - 1, sd, 4, 0, 0, 0).getTime()
    const endTs = new Date(ey, em - 1, ed + 1, 4, 0, 0, 0).getTime()
    const projects = projectsMod.listProjects()
    const rows = db.all<{ project_id: number | null; ms: number }>(
      `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
       WHERE is_deleted = 0 AND start_ts < ? AND end_ts > ? GROUP BY project_id`,
      [endTs, startTs]
    )
    const taskRows = db.all<{ project_id: number | null; ms: number }>(
      `SELECT project_id, SUM(COALESCE(end_ts, ?) - start_ts) AS ms FROM task_activities
       WHERE is_deleted = 0 AND start_ts < ? AND (end_ts IS NULL OR end_ts > ?) GROUP BY project_id`,
      [Date.now(), endTs, startTs]
    )
    const byProject = new Map<number | null, number>()
    for (const r of [...rows, ...taskRows]) {
      byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + r.ms)
    }
    const unclassifiedMin = Math.round((byProject.get(null) ?? 0) / 60000)
    const stats = projects
      .map((p) => {
        let minutes = Math.round((byProject.get(p.id) ?? 0) / 60000)
        // Roll children into ancestors (Timing reports the whole subtree).
        const childMinutes = (pid: number): number =>
          projects
            .filter((c) => c.parentId === pid)
            .reduce((acc, c) => acc + Math.round((byProject.get(c.id) ?? 0) / 60000) + childMinutes(c.id), 0)
        minutes += childMinutes(p.id)
        return {
          projectId: p.id,
          title: p.title,
          color: p.color,
          parentId: p.parentId,
          productivityScore: p.productivityScore,
          minutes
        }
      })
      .filter((s) => s.minutes > 0 || projects.some((p) => p.id === s.projectId))
    const scoredMinutes = stats.filter((s) => s.productivityScore !== 0)
    const totalScored = scoredMinutes.reduce((a, s) => a + s.minutes, 0)
    const productivityIndex =
      totalScored > 0
        ? Math.round(scoredMinutes.reduce((a, s) => a + s.minutes * s.productivityScore, 0) / totalScored)
        : null
    return { stats, unclassifiedMinutes: unclassifiedMin, productivityIndex }
  })

  ipcMain.handle('report:timesheet', async (_e, startDay: string, endDay: string) => {
    const [sy, sm, sd] = startDay.split('-').map(Number)
    const [ey, em, ed] = endDay.split('-').map(Number)
    let cursorTs = new Date(sy, sm - 1, sd, 4, 0, 0, 0).getTime()
    const endTs = new Date(ey, em - 1, ed + 1, 4, 0, 0, 0).getTime()
    const projects = projectsMod.listProjects()
    const lines = ['日期,项目,分钟,效率分,是否可计费']
    let guard = 0
    while (cursorTs < endTs && guard < 400) {
      const dayEnd = cursorTs + 86400_000
      const d = new Date(cursorTs)
      const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const rows = db.all<{ project_id: number | null; ms: number }>(
        `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
         WHERE is_deleted = 0 AND start_ts >= ? AND start_ts < ? GROUP BY project_id`,
        [cursorTs, dayEnd]
      )
      const byProject = new Map<number | null, number>()
      for (const r of rows) byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + r.ms)
      for (const [pid, ms] of byProject) {
        const proj = projects.find((p) => p.id === pid)
        lines.push(
          `${dayStr},${proj ? proj.title.replace(/,/g, '，') : '（未归类）'},${Math.round(ms / 60000)},${proj?.productivityScore ?? 0},${proj?.billableByDefault ? '是' : '否'}`
        )
      }
      cursorTs = dayEnd
      guard++
    }
    const result = await dialog.showSaveDialog(win, {
      title: '导出工时表',
      defaultPath: `timesheet-${startDay}-to-${endDay}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, message: '已取消。' }
    // UTF-8 BOM so Excel opens Chinese correctly.
    fs.writeFileSync(result.filePath, '\ufeff' + lines.join('\n'), 'utf-8')
    return { ok: true, message: `已导出到 ${result.filePath}` }
  })
}
