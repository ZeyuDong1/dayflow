import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AppActivity,
  CaptureStatus,
  ChatConversation,
  ClassificationEntry,
  ChatMessage,
  DayPlan,
  DeepPartial,
  Project,
  ProjectsOverview,
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
  mergeProjects: (sourceId: number, targetId: number): Promise<Project[]> =>
    ipcRenderer.invoke('projects:merge', sourceId, targetId),
  getProjectsOverview: (): Promise<ProjectsOverview> => ipcRenderer.invoke('projects:overview'),
  listClassifications: (): Promise<ClassificationEntry[]> =>
    ipcRenderer.invoke('classifications:list'),
  deleteClassification: (appName: string, titlePattern: string): Promise<boolean> =>
    ipcRenderer.invoke('classifications:delete', appName, titlePattern),

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
    downloading: boolean
  }> => ipcRenderer.invoke('tutor:status'),
  tutorReflectNow: (): Promise<boolean> => ipcRenderer.invoke('tutor:reflectNow'),
  tutorStartMemory: (): Promise<boolean> => ipcRenderer.invoke('tutor:startMemory'),
  tutorSearchMemory: (
    query: string
  ): Promise<{ path: string; title: string; snippet: string; rank: number }[]> =>
    ipcRenderer.invoke('tutor:searchMemory', query),

  // 学习监督(升级阶梯打断 + 强打断面板)
  supervisionStatus: (): Promise<{
    active: boolean
    deviating: boolean
    devMinutes: number
    breakUntil: number | null
    pausedToday: boolean
    overlayOpen: boolean
  }> => ipcRenderer.invoke('supervision:status'),
  supervisionFeedback: (text: string): Promise<string> =>
    ipcRenderer.invoke('supervision:feedback', text),
  supervisionBreak: (minutes?: number): Promise<boolean> =>
    ipcRenderer.invoke('supervision:break', minutes),
  supervisionEarnedBreak: (seconds: number): Promise<boolean> =>
    ipcRenderer.invoke('supervision:earnedBreak', seconds),
  supervisionStopToday: (): Promise<boolean> => ipcRenderer.invoke('supervision:stopToday'),
  supervisionPreview: (strict?: boolean): Promise<boolean> =>
    ipcRenderer.invoke('supervision:preview', strict),
  supervisionInterruptState: (): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('supervision:interruptState'),
  supervisionMinimizeTarget: (): Promise<boolean> =>
    ipcRenderer.invoke('supervision:minimizeTarget'),
  supervisionCloseTarget: (): Promise<boolean> => ipcRenderer.invoke('supervision:closeTarget'),
  onSupervisionInterrupt: (cb: (payload: Record<string, unknown>) => void): (() => void) => {
    const listener = (_e: unknown, payload: Record<string, unknown>): void => cb(payload)
    ipcRenderer.on('supervision:interrupt', listener)
    return () => ipcRenderer.removeListener('supervision:interrupt', listener)
  },
  // 任务域（EpochToDo 融合）
  todo: {
    getTasks: (): Promise<import('../shared/todo-types').TaskRow[]> => ipcRenderer.invoke('todo:get-tasks'),
    updateTask: (
      id: number,
      updates: Partial<import('../shared/todo-types').TaskRow>,
    ): Promise<import('../shared/todo-types').TaskRow | null> => ipcRenderer.invoke('todo:update-task', id, updates),
    completeTask: (id: number): void => {
      ipcRenderer.send('todo:complete-task', id)
    },
    startFocus: (id: number): void => {
      ipcRenderer.send('todo:start-focus', id)
    },
    stopTraining: (id: number, force?: boolean): Promise<void> =>
      ipcRenderer.invoke('todo:stop-training', id, force),
    snooze: (id: number, minutes: number): Promise<void> => ipcRenderer.invoke('todo:snooze', id, minutes),
    hideReminder: (): void => {
      ipcRenderer.send('todo:reminder-hide')
    },
    hideSpotlight: (): void => {
      ipcRenderer.send('todo:hide-spotlight')
    },
    createTask: (
      title: string,
      opts?: {
        type?: string
        projectId?: number | null
        parentId?: number | null
        skipDedup?: boolean
        tag?: string
        estimated_duration?: number | null
      },
    ): Promise<import('../shared/todo-types').TaskRow> =>
      ipcRenderer.invoke('todo:create-task', title, opts),
    getSuggestions: (maxMinutes?: number): Promise<import('../shared/todo-types').TaskRow[]> =>
      ipcRenderer.invoke('todo:get-suggestions', maxMinutes),
    setSideFocus: (id: number, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('todo:set-side-focus', id, enabled),
    deleteTask: (id: number): Promise<number[]> => ipcRenderer.invoke('todo:delete-task', id),
    startWait: (id: number, seconds: number): void => {
      ipcRenderer.send('todo:start-wait', id, seconds)
    },
    cancelWait: (id: number): void => {
      ipcRenderer.send('todo:cancel-wait', id)
    },
    addMemo: (id: number, text: string): void => {
      ipcRenderer.send('todo:add-memo', id, text)
    },
    assignGpu: (taskId: number, gpuId: number, minutes: number): void => {
      ipcRenderer.send('todo:assign-gpu', taskId, gpuId, minutes)
    },
    aiPromote: (source: string, title: string, detail?: string, link?: string): Promise<unknown> =>
      ipcRenderer.invoke('todo:ai-promote', source, title, detail, link),
    aiDismiss: (payload: { id?: string; source?: string; title?: string; force?: boolean }): void => {
      ipcRenderer.send('todo:ai-dismiss', payload)
    },
    focusToday: (): Promise<number> => ipcRenderer.invoke('todo:focus-today'),
    getGpus: (): Promise<(import('../shared/todo-types').GpuRow & { activeTaskId: number | null })[]> =>
      ipcRenderer.invoke('todo:get-gpus'),
    createGpu: (name: string): Promise<import('../shared/todo-types').GpuRow> =>
      ipcRenderer.invoke('todo:create-gpu', name),
    deleteGpu: (id: number): Promise<void> => ipcRenderer.invoke('todo:delete-gpu', id),
    getSettings: (): Promise<unknown> => ipcRenderer.invoke('todo:get-settings'),
    updateSettings: (patch: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('todo:update-settings', patch),
    setOverlayIgnoreMouse: (ignore: boolean): void => {
      ipcRenderer.send('todo:set-overlay-ignore-mouse', ignore)
    },
    resetOverlayPosition: (): void => {
      ipcRenderer.send('todo:reset-overlay-position')
    },
    focusSessions: (
      day: string,
    ): Promise<{ id: number; taskId: number | null; title: string; startTs: number; endTs: number }[]> =>
      ipcRenderer.invoke('todo:focus-sessions', day),
    sessionAnalyses: (day: string): Promise<unknown[]> => ipcRenderer.invoke('todo:session-analyses', day),
    analyzeDay: (day: string): Promise<number> => ipcRenderer.invoke('todo:analyze-day', day),
    wandbUpdate: (): void => {
      ipcRenderer.send('wandb:update')
    },
    wandbTest: (
      entity: string,
      apiKey: string,
    ): Promise<{ valid: boolean; projectCount: number; hostname: string; error?: string }> =>
      ipcRenderer.invoke('wandb:test', entity, apiKey),
    openExternal: (url: string): void => {
      ipcRenderer.invoke('todo:open-external', url)
    },
    trainingStatus: (): Promise<unknown[]> => ipcRenderer.invoke('todo:training-status'),
    setShortcut: (accelerator: string): Promise<boolean> => ipcRenderer.invoke('todo:set-shortcut', accelerator),
    exportData: (): Promise<{ path: string } | null> => ipcRenderer.invoke('todo:export-data'),
    importData: (): Promise<{ needsRestart: boolean } | null> => ipcRenderer.invoke('todo:import-data'),
    clearData: (): Promise<boolean> => ipcRenderer.invoke('todo:clear-data'),
    mdSync: {
      selectFolder: (): Promise<string | null> => ipcRenderer.invoke('md-sync:select-folder'),
      setConfig: (enabled: boolean, folder: string): Promise<void> =>
        ipcRenderer.invoke('md-sync:set-config', enabled, folder),
      getStatus: (): Promise<{
        enabled: boolean
        folder: string
        filePath: string
        watching: boolean
        lastSyncTime: number | null
        error: string | null
      }> => ipcRenderer.invoke('md-sync:get-status'),
      importFile: (filePath: string, force: boolean): Promise<{ created: number; updated: number; duplicates: string[] }> =>
        ipcRenderer.invoke('md-sync:import', filePath, force),
      exportTo: (folder: string): Promise<void> => ipcRenderer.invoke('md-sync:export', folder),
      syncNow: (folder: string): Promise<{ created: number; updated: number; deleted: number }> =>
        ipcRenderer.invoke('md-sync:sync', folder),
      checkFile: (folder: string): Promise<{ exists: boolean; bullets: number; titles: string[] }> =>
        ipcRenderer.invoke('md-sync:check-file', folder),
      checkDuplicates: (titles: string[]): Promise<string[]> => ipcRenderer.invoke('md-sync:check-duplicates', titles),
      readFile: (filePath: string): Promise<string> => ipcRenderer.invoke('md-sync:read-file', filePath),
    },
    execCommand: (
      parsed: import('../shared/commands').ParsedCommand,
      ctx: { activeTaskId?: number | null; highlightedId?: number | null; suggestionIds?: number[] },
    ): Promise<{ kind: string; taskId?: number; draft?: unknown; reason?: string }> =>
      ipcRenderer.invoke('todo:exec-command', parsed, ctx),
    execGpuPick: (
      draft: { title: string; time: number; projectId: number | null; sub?: string },
      gpuId: number,
    ): Promise<{ kind: string; taskId?: number }> => ipcRenderer.invoke('todo:exec-gpu-pick', draft, gpuId),
    listTaskProjects: (): Promise<import('../shared/todo-types').TaskProject[]> =>
      ipcRenderer.invoke('todo:list-task-projects'),
    createTaskProject: (name: string, color?: string): Promise<import('../shared/todo-types').TaskProject> =>
      ipcRenderer.invoke('todo:create-task-project', name, color),
    updateTaskProject: (
      id: number,
      updates: { name?: string; color?: string | null },
    ): Promise<import('../shared/todo-types').TaskProject | null> =>
      ipcRenderer.invoke('todo:update-task-project', id, updates),
    deleteTaskProject: (id: number): Promise<boolean> => ipcRenderer.invoke('todo:delete-task-project', id),
    onEvent: (cb: (event: import('../shared/todo-types').TodoEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: import('../shared/todo-types').TodoEvent): void => cb(event)
      ipcRenderer.on('todo:event', listener)
      return () => ipcRenderer.removeListener('todo:event', listener)
    },
  },
}

export type DayflowApi = typeof api

contextBridge.exposeInMainWorld('dayflow', api)
