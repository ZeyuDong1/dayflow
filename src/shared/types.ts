// Shared types between the Electron main process and the renderer.

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type ProviderId =
  | 'none'
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'zhipu'
  | 'mimo'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'

export interface GeminiConfig {
  apiKey: string
  model: string
}

export interface OpenAIConfig {
  apiKey: string
  model: string
  baseUrl: string // default https://api.openai.com/v1
}

export interface AnthropicConfig {
  apiKey: string
  model: string
}

export interface ZhipuConfig {
  apiKey: string
  /** 'api' = 开放平台按量计费（OpenAI 兼容）; 'coding' = GLM Coding Plan 订阅（Anthropic 兼容） */
  mode: 'api' | 'coding'
  model: string // used in api mode
  baseUrl: string // default https://open.bigmodel.cn/api/paas/v4
  codingModel: string // used in coding mode
  codingBaseUrl: string // default https://open.bigmodel.cn/api/anthropic
}

export interface MimoConfig {
  apiKey: string
  /** 'api' = 开放平台按量计费（OpenAI 兼容）; 'coding' = Token Plan 订阅（Anthropic 兼容） */
  mode: 'api' | 'coding'
  model: string // used in api mode
  baseUrl: string // default https://api.xiaomimimo.com/v1
  codingModel: string // used in coding mode
  codingBaseUrl: string // default https://api.xiaomimimo.com/anthropic
}

export interface OllamaConfig {
  baseUrl: string // default http://localhost:11434
  model: string
}

export interface LMStudioConfig {
  baseUrl: string // default http://localhost:1234/v1
  model: string
}

export interface OpenAICompatibleConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AIConfig {
  provider: ProviderId
  gemini: GeminiConfig
  openai: OpenAIConfig
  anthropic: AnthropicConfig
  zhipu: ZhipuConfig
  mimo: MimoConfig
  ollama: OllamaConfig
  lmstudio: LMStudioConfig
  'openai-compatible': OpenAICompatibleConfig
}

export interface CaptureConfig {
  enabled: boolean
  intervalSec: number // options 1 | 5 | 10 | 20 | 30 | 60
  captureHeight: number // options 720 | 1080
  captureAllDisplays: boolean // stitch every monitor into one panorama frame
  idleThresholdSec: number // system idle beyond this counts as idle
  privateApps: string[] // process names to replace with placeholder
  pauseUntil: number | null // epoch ms until which capture is paused
}

export interface StorageConfig {
  recordingsLimitBytes: number // default 10 GB
  autoCleanup: boolean
}

export interface GeneralConfig {
  launchAtLogin: boolean
  outputLanguage: string // '' = auto (model matches screen language)
  userName: string
}

// ---------------------------------------------------------------------------
// 学习守护（常驻 Agent，非会话制）
// ---------------------------------------------------------------------------

export interface TutorConfig {
  enabled: boolean // 守护开关：开启后 Agent 一直在线监督
  goal: string // 学习目标描述（判定与督促语的依据）
  allowedProjectIds: number[] // 学习项目白名单；为空时按效率分判定(>=6 学习, <=3 分心)
  gentleSec: number // 分心持续多久发轻提醒（桌面通知）
  interruptSec: number // 分心持续多久强打断（置顶弹窗 + 声音）
  repeatSec: number // 持续分心时重复强打断的间隔
  breakMinutes: number // 一键休息的默认时长
  allowBreak: boolean // 允许强打断面板"休息一下"暂停遮蔽；关=面板不提供该出口
  allowPostpone: boolean // 允许轻提醒通知"稍后提醒"延迟一次；关=点击不延迟
  soundEnabled: boolean // 强打断时播放提示音
  reflectMinutes: number // 导师反思轮询间隔（分钟, 1-240, 默认 10）
}

export type TutorMode = 'off' | 'idle' | 'learning' | 'non-learning' | 'break'

export interface TutorTodayStat {
  focusMs: number // 今日学习时长
  devMs: number // 今日分心时长
  interruptCount: number // 今日被打断次数
}

export interface TutorStatus {
  enabled: boolean
  mode: TutorMode
  goal: string
  currentApp: string
  currentTitle: string
  deviationSince: number | null // 本轮分心开始时间
  breakUntil: number | null
  today: TutorTodayStat
  alertOpen: boolean
}

export interface TutorEvent {
  id: number
  ts: number
  type: string // interrupt | gentle | break | snooze | back_to_study | false_positive
  appName: string | null
  title: string | null
  detail: string | null
}

export interface TutorAlertPayload {
  goal: string
  appName: string
  title: string
  devMinutes: number
  nudge: string
  breakMinutes: number
  soundEnabled: boolean
}

export interface AppSettings {
  ai: AIConfig
  capture: CaptureConfig
  storage: StorageConfig
  general: GeneralConfig
  tutor: TutorConfig
}

export interface TimelineCategory {
  id: string
  name: string
  colorHex: string
  details: string
  order: number
  isSystem: boolean
  isIdle: boolean
}

export interface Distraction {
  startTime: string
  endTime: string
  title: string
  summary: string
}

export interface AppSites {
  primary: string | null
  secondary: string | null
}

export interface TimelineCard {
  id: number
  batchId: number | null
  start: string // clock time "2:30 PM"
  end: string
  startTs: number
  endTs: number
  day: string // YYYY-MM-DD local (4 AM day boundary)
  title: string
  summary: string
  category: string
  subcategory: string
  detailedSummary: string
  distractions: Distraction[]
  appSites: AppSites | null
  isIdle: boolean
  screenshotCount: number
}

export interface StandupPayload {
  highlights: string[]
  blockers: string[]
  summary: string
  generatedAt: number
  model: string
}

export interface DayPlan {
  day: string
  priorities: { id: string; text: string; done: boolean }[]
  blockers: string
  updatedAt: number
}

export interface CaptureStatus {
  capturing: boolean
  pausedUntil: number | null
  enabled: boolean
  provider: ProviderId
  providerReady: boolean
  lastCaptureAt: number | null
  pendingScreenshots: number
  lastError: string | null
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface ChatConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface WeeklyCardStat {
  totalMinutes: number
  focusMinutes: number
  distractionMinutes: number
  idleMinutes: number
  personalMinutes: number
  topCategory: string | null
  topApp: string | null
  longestFocusStreakMin: number
  activeDays: number
  avgStartMinute: number | null
  avgEndMinute: number | null
}

export interface CategorySlice {
  name: string
  colorHex: string
  minutes: number
}

export interface AppUsage {
  app: string
  minutes: number
  category: string
  colorHex: string
}

export interface WorkflowCell {
  minute: number
  categoryName: string | null
  colorHex: string | null
  minutes: number
}

export interface WorkflowRow {
  day: string
  dayLabel: string
  cells: WorkflowCell[]
}

export interface HeatmapCell {
  hour: number
  focusRatio: number // 0..1, -1 = no data
  minutes: number
}

export interface HeatmapRow {
  day: string
  dayLabel: string
  cells: HeatmapCell[]
}

export interface InteractionEdge {
  from: string
  to: string
  count: number
}

export interface InteractionGraph {
  nodes: { app: string; minutes: number }[]
  edges: InteractionEdge[]
}

export interface WeeklyReview {
  weekStart: string
  weekEnd: string
  stats: WeeklyCardStat
  categories: CategorySlice[]
  apps: AppUsage[]
  workflow: WorkflowRow[]
  heatmap: HeatmapRow[]
  interactions: InteractionGraph
}

export interface StorageUsage {
  recordingsBytes: number
  dbBytes: number
  screenshotCount: number
  cardCount: number
}

export interface DaySummary {
  day: string
  totalMinutes: number
  focusMinutes: number
  distractionMinutes: number
  categories: CategorySlice[]
}

// ---------------------------------------------------------------------------
// Timing-style entities (window-title-first tracking)
// ---------------------------------------------------------------------------

export interface Project {
  id: number
  parentId: number | null
  title: string
  color: string
  productivityScore: number
  billableByDefault: boolean
  listPosition: number
}

export type RuleField = 'app' | 'title' | 'urlOrPath'
export type RuleOp = 'contains' | 'equals' | 'startsWith' | 'regex'

export interface RuleCondition {
  field: RuleField
  op: RuleOp
  value: string
}

/** Timing-style predicate tree: nested AND / OR / NOT groups of conditions. */
export type RuleNode =
  | { kind: 'cond'; field: RuleField; op: RuleOp; value: string }
  | { kind: 'all' | 'any'; children: RuleNode[] }
  | { kind: 'not'; child: RuleNode }

export interface Rule {
  id: number
  projectId: number
  conditions: RuleNode
  listPosition: number
}

export interface AppActivity {
  id: number
  startTs: number
  endTs: number
  appName: string
  title: string
  urlOrPath: string | null
  projectId: number | null
  isManual: boolean
  cardId: number | null
  isIdle?: boolean // 段内大部分时间无键鼠输入
}

export interface TaskActivity {
  id: number
  startTs: number
  endTs: number | null
  title: string
  notes: string
  projectId: number | null
  billable: boolean
  running: boolean
}

/** 项目管理页：每项目的时长统计（不含子项目滚动，渲染层自行汇总）。 */
export interface ProjectStats {
  projectId: number
  todayMin: number
  weekMin: number
  monthMin: number
  segments: number // 近 30 天活动段数
  topApps: { app: string; minutes: number }[] // 近 30 天，按占用排序
}

export interface ProjectsOverview {
  stats: ProjectStats[]
  unclassifiedMin: { today: number; week: number; month: number }
  productivityIndex: number | null // 近 30 天加权效率指数
}

/** 学到的自动归类映射（手动归类 / LLM 判定的记忆）。 */
export interface ClassificationEntry {
  appName: string
  titlePattern: string // '*' = 整个应用级别
  projectId: number
  hits: number
  updatedAt: number
}

export interface ProjectSuggestion {
  appName: string
  titlePattern: string
  projectId: number
  hits: number
  projectTitle: string
  projectColor: string
}

export interface RuleSuggestionItem {
  appName: string
  titlePattern: string
  totalMinutes: number
  suggestion: ProjectSuggestion | null
}
