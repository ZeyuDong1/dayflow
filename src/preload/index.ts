import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AppActivity,
  CaptureStatus,
  ChatConversation,
  ChatMessage,
  DayPlan,
  DeepPartial,
  Project,
  Rule,
  RuleCondition,
  RuleNode,
  RuleSuggestionItem,
  StandupPayload,
  StorageUsage,
  TaskActivity,
  TimelineCard,
  WeeklyReview
} from '../shared/types'

export interface CardScreenshot {
  id: number
  capturedAt: number
  dataUrl: string
}

export interface DayData {
  cards: TimelineCard[]
  summary: {
    day: string
    totalMinutes: number
    focusMinutes: number
    distractionMinutes: number
    categories: { name: string; colorHex: string; minutes: number }[]
  }
  pending: number
  pipelineError: string | null
}

const api = {
  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: DeepPartial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  isOnboarded: (): Promise<boolean> => ipcRenderer.invoke('onboarded:get'),
  completeOnboarding: (role: string): Promise<boolean> =>
    ipcRenderer.invoke('onboard:complete', role),

  // Capture
  getCaptureStatus: (): Promise<{ enabled: boolean; pausedUntil: number | null; intervalSec: number }> =>
    ipcRenderer.invoke('capture:status'),
  pauseCapture: (minutes: number): Promise<number> => ipcRenderer.invoke('capture:pause', minutes),
  resumeCapture: (): Promise<boolean> => ipcRenderer.invoke('capture:resume'),

  // Timeline
  getDay: (day: string): Promise<DayData> => ipcRenderer.invoke('timeline:day', day),
  getTodayKey: (): Promise<string> => ipcRenderer.invoke('timeline:today'),
  deleteCard: (id: number): Promise<boolean> => ipcRenderer.invoke('timeline:deleteCard', id),
  deleteDay: (day: string): Promise<boolean> => ipcRenderer.invoke('timeline:deleteDay', day),
  reprocessDay: (day: string): Promise<number> => ipcRenderer.invoke('timeline:reprocessDay', day),
  forceFlush: (): Promise<boolean> => ipcRenderer.invoke('timeline:forceFlush'),
  getScreenshotsForCard: (card: TimelineCard, max?: number): Promise<CardScreenshot[]> =>
    ipcRenderer.invoke('screenshots:forCard', card, max),
  onTimelineChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('timeline:changed', listener)
    return () => ipcRenderer.removeListener('timeline:changed', listener)
  },

  // Standup / daily
  getStandup: (day: string): Promise<StandupPayload | null> =>
    ipcRenderer.invoke('standup:get', day),
  generateStandup: (
    day: string
  ): Promise<{ ok: boolean; payload?: StandupPayload; error?: string }> =>
    ipcRenderer.invoke('standup:generate', day),
  getDayPlan: (day: string): Promise<DayPlan> => ipcRenderer.invoke('plan:get', day),
  saveDayPlan: (plan: DayPlan): Promise<boolean> => ipcRenderer.invoke('plan:save', plan),

  // Weekly
  getWeekly: (dayInWeek: string): Promise<WeeklyReview> =>
    ipcRenderer.invoke('weekly:get', dayInWeek),

  // Chat
  listConversations: (): Promise<ChatConversation[]> =>
    ipcRenderer.invoke('chat:conversations'),
  newConversation: (title: string): Promise<ChatConversation> =>
    ipcRenderer.invoke('chat:new', title),
  getMessages: (id: string): Promise<ChatMessage[]> => ipcRenderer.invoke('chat:messages', id),
  deleteConversation: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:delete', id),
  sendMessage: (id: string, question: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:send', id, question),
  abortChat: (id: string): Promise<boolean> => ipcRenderer.invoke('chat:abort', id),
  onChatEvent: (
    cb: (event: { conversationId: string; type: 'token' | 'done' | 'error'; delta?: string; full?: string; message?: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, payload: typeof cb extends (event: infer P) => void ? P : never): void =>
      cb(payload)
    ipcRenderer.on('chat:event', listener as never)
    return () => ipcRenderer.removeListener('chat:event', listener as never)
  },

  // AI admin
  testConnection: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('ai:test'),
  listModels: (
    provider: string
  ): Promise<{ models: string[]; source: 'api' | 'fallback' | 'builtin'; message?: string }> =>
    ipcRenderer.invoke('ai:models', provider),

  // Export / storage / misc
  exportMarkdown: (start: string, end: string): Promise<{ ok: boolean; path?: string; message: string }> =>
    ipcRenderer.invoke('export:markdown', start, end),
  getStorageUsage: (): Promise<StorageUsage> => ipcRenderer.invoke('storage:usage'),
  cleanupNow: (): Promise<StorageUsage> => ipcRenderer.invoke('storage:cleanupNow'),
  deleteAllData: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('storage:deleteAll'),
  openDataFolder: (): Promise<boolean> => ipcRenderer.invoke('app:openRecordings'),
  setLoginItem: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setLoginItem', enabled),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getAppIcons: (names: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('apps:icons', names),

  // Timing-style: projects / rules / activities / tasks / reports
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  createProject: (input: {
    title: string
    parentId?: number | null
    color?: string
    productivityScore?: number
    billableByDefault?: boolean
  }): Promise<Project> => ipcRenderer.invoke('projects:create', input),
  updateProject: (id: number, patch: Partial<Project>): Promise<Project[]> =>
    ipcRenderer.invoke('projects:update', id, patch),
  deleteProject: (id: number): Promise<Project[]> => ipcRenderer.invoke('projects:delete', id),

  listRules: (): Promise<Rule[]> => ipcRenderer.invoke('rules:list'),
  createRule: (
    projectId: number,
    conditions: RuleCondition[] | RuleNode
  ): Promise<{ rule: Rule; appliedCount: number }> =>
    ipcRenderer.invoke('rules:create', projectId, conditions),
  deleteRule: (id: number): Promise<Rule[]> => ipcRenderer.invoke('rules:delete', id),

  getActivities: (day: string): Promise<AppActivity[]> => ipcRenderer.invoke('activities:day', day),
  assignActivity: (activityId: number, projectId: number | null): Promise<boolean> =>
    ipcRenderer.invoke('activities:assign', activityId, projectId),
  bulkAssign: (appName: string, pattern: string, projectId: number): Promise<number> =>
    ipcRenderer.invoke('activities:bulkAssign', appName, pattern, projectId),
  reviewUnclassified: (): Promise<RuleSuggestionItem[]> => ipcRenderer.invoke('review:unclassified'),
  aiGroupUnclassified: (
    days = 7
  ): Promise<{
    ok: boolean
    groups?: {
      name: string
      reason: string
      projectId: number | null
      projectTitle: string | null
      items: { appName: string; titlePattern: string; totalMinutes: number }[]
      totalMinutes: number
    }[]
    error?: string
  }> => ipcRenderer.invoke('review:aiGroup', days),
  applyAiGroup: (
    group: { name: string; reason: string; projectId: number | null; projectTitle: string | null; items: { appName: string; titlePattern: string; totalMinutes: number }[]; totalMinutes: number },
    projectId: number
  ): Promise<number> => ipcRenderer.invoke('review:applyGroup', group, projectId),

  listTasks: (startTs: number, endTs: number): Promise<TaskActivity[]> =>
    ipcRenderer.invoke('tasks:range', startTs, endTs),
  startTask: (title: string, projectId: number | null, billable: boolean): Promise<TaskActivity> =>
    ipcRenderer.invoke('tasks:start', title, projectId, billable),
  stopTask: (): Promise<boolean> => ipcRenderer.invoke('tasks:stop'),
  getRunningTask: (): Promise<TaskActivity | null> => ipcRenderer.invoke('tasks:running'),
  createManualTask: (
    startTs: number,
    endTs: number,
    title: string,
    projectId: number | null,
    billable: boolean
  ): Promise<boolean> => ipcRenderer.invoke('tasks:create', startTs, endTs, title, projectId, billable),
  deleteTask: (id: number): Promise<boolean> => ipcRenderer.invoke('tasks:delete', id),

  projectStats: (
    startDay: string,
    endDay: string
  ): Promise<{
    stats: { projectId: number; title: string; color: string; parentId: number | null; productivityScore: number; minutes: number }[]
    unclassifiedMinutes: number
    productivityIndex: number | null
  }> => ipcRenderer.invoke('report:projectStats', startDay, endDay),
  exportTimesheet: (startDay: string, endDay: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('report:timesheet', startDay, endDay),

  // 学习导师（记忆 + 反思）
  tutorStatus: (): Promise<{
    running: boolean
    port: number
    dataDir: string
    binaryPath: string
    version: string
    lastError: string | null
  }> => ipcRenderer.invoke('tutor:status'),
  tutorReflectNow: (): Promise<boolean> => ipcRenderer.invoke('tutor:reflectNow'),
  tutorSearchMemory: (
    query: string
  ): Promise<{ path: string; title: string; snippet: string; rank: number }[]> =>
    ipcRenderer.invoke('tutor:searchMemory', query)
}

export type DayflowApi = typeof api

contextBridge.exposeInMainWorld('dayflow', api)
