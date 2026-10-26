import { db } from './db'
import type { AppSettings, DeepPartial, TimelineCategory } from '../shared/types'

export const SETTINGS_KEY = 'app-settings'
export const CATEGORIES_KEY = 'categories'
export const ONBOARDING_KEY = 'onboarding-done'

export const defaultSettings: AppSettings = {
  ai: {
    provider: 'none',
    gemini: { apiKey: '', model: 'gemini-2.5-flash' },
    openai: { apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { apiKey: '', model: 'claude-sonnet-4-5' },
    zhipu: {
      apiKey: '',
      mode: 'api',
      model: 'glm-5.3-flash',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      codingModel: 'glm-5.3',
      codingBaseUrl: 'https://open.bigmodel.cn/api/anthropic'
    },
    mimo: {
      apiKey: '',
      mode: 'api',
      model: 'mimo-v2.5-pro',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      codingModel: 'mimo-v2.5-pro',
      codingBaseUrl: 'https://api.xiaomimimo.com/anthropic'
    },
    ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5vl:7b' },
    lmstudio: { baseUrl: 'http://localhost:1234/v1', model: '' },
    'openai-compatible': { baseUrl: '', apiKey: '', model: '' }
  },
  capture: {
    enabled: true,
    intervalSec: 30, // screenshots are the secondary signal now; window polling runs at 2s
    captureHeight: 1080,
    captureAllDisplays: true,
    idleThresholdSec: 300,
    privateApps: [
      '1password',
      'authy',
      'bitwarden',
      'dashlane',
      'enpass',
      'keeper',
      'keepassxc',
      'lastpass',
      'ledger live',
      'nordpass',
      'proton pass',
      'trezor suite',
      'yubico authenticator'
    ],
    pauseUntil: null
  },
  storage: {
    recordingsLimitBytes: 10_000_000_000, // 10 GB, matches Dayflow default
    autoCleanup: true
  },
  general: {
    launchAtLogin: false,
    outputLanguage: '中文',
    userName: ''
  },
  tutor: {
    enabled: false,
    goal: '',
    allowedProjectIds: [],
    gentleSec: 60, // 分心 1 分钟先发桌面轻提醒
    interruptSec: 180, // 分心 3 分钟置顶弹窗强打断
    repeatSec: 600, // 持续分心每 10 分钟再打断一次
    breakMinutes: 10,
    allowBreak: true,
    allowPostpone: true,
    allowStopToday: true,
    earnedBreakCooldownMin: 15, // 番茄休息冷却:支取休息自然结束后需等待才能再次支取(0=无)
    breakRatioMinutes: 5,
    soundEnabled: true,
    reflectMinutes: 10 // 导师反思轮询间隔（可自定义 1-240 分钟）
  }
}

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined | null): T {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out = { ...(base as object) } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k]
    out[k] = b !== undefined && typeof b === 'object' && b !== null && !Array.isArray(b)
      ? deepMerge(b as Record<string, unknown>, v as DeepPartial<Record<string, unknown>>)
      : v
  }
  return out as T
}

/** Strip accidental whitespace from stored base URLs (paste accidents break fetch). */
function sanitizeSettings(s: AppSettings): AppSettings {
  const clean = (u: string): string => u.replace(/\s+/g, '')
  s.ai.openai.baseUrl = clean(s.ai.openai.baseUrl)
  s.ai.zhipu.baseUrl = clean(s.ai.zhipu.baseUrl)
  s.ai.zhipu.codingBaseUrl = clean(s.ai.zhipu.codingBaseUrl)
  s.ai.mimo.baseUrl = clean(s.ai.mimo.baseUrl)
  s.ai.mimo.codingBaseUrl = clean(s.ai.mimo.codingBaseUrl)
  s.ai.ollama.baseUrl = clean(s.ai.ollama.baseUrl)
  s.ai.lmstudio.baseUrl = clean(s.ai.lmstudio.baseUrl)
  s.ai['openai-compatible'].baseUrl = clean(s.ai['openai-compatible'].baseUrl)
  return s
}

export function getSettings(): AppSettings {
  const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY])
  if (!row) return structuredClone(defaultSettings)
  try {
    return sanitizeSettings(deepMerge(structuredClone(defaultSettings), JSON.parse(row.value)))
  } catch {
    return structuredClone(defaultSettings)
  }
}

export function saveSettings(patch: DeepPartial<AppSettings>): AppSettings {
  const current = getSettings()
  const next = deepMerge(current, patch)
  db.run(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
    [SETTINGS_KEY, JSON.stringify(next)]
  )
  return next
}

// ---------------------------------------------------------------------------
// Categories (ported from Dayflow's TimelineCategory + role presets)
// ---------------------------------------------------------------------------

export const DEFAULT_CATEGORIES: Omit<TimelineCategory, 'id'>[] = [
  {
    name: 'Work',
    colorHex: '#B984FF',
    details:
      'Career, school, or productivity-focused activities (projects, emails, assignments, video calls, learning skills, etc.)',
    order: 0,
    isSystem: false,
    isIdle: false
  },
  {
    name: 'Personal',
    colorHex: '#6AADFF',
    details:
      'Purposeful non-work activities or life tasks (paying bills, fitness tracking, meal planning, personal research, creative hobbies, etc.)',
    order: 1,
    isSystem: false,
    isIdle: false
  },
  {
    name: 'Distraction',
    colorHex: '#FF5950',
    details:
      'Passive consumption or aimless browsing (scrolling feeds, watching random videos, clicking through news, mindless games, etc.)',
    order: 2,
    isSystem: false,
    isIdle: false
  },
  {
    name: 'Idle',
    colorHex: '#A0AEC0',
    details: 'For when the user is idle for most of the time.',
    order: 3,
    isSystem: true,
    isIdle: true
  }
]

const ROLE_PRESETS: Record<string, [string, string, string][]> = {
  'Software Engineer': [
    ['Coding / Debugging', '#6A7EFF', 'Writing, refactoring, and fixing code in an IDE or terminal'],
    ['Code Review', '#56CFEE', 'Reviewing PRs, reading diffs, and leaving comments'],
    [
      'Research',
      '#C787F7',
      'Reading docs, Stack Overflow, exploring tools and APIs, and writing design docs or technical specs'
    ],
    ['Communication', '#FFAE8C', 'Meetings, standups, Slack, email, video calls, messaging, and syncs'],
    [
      'Distraction',
      '#FF4721',
      'Unfocused browsing and passive content consumption: social media feeds, random videos, idle scrolling, entertainment with no clear intent, and gaming'
    ],
    [
      'Personal',
      '#ADE3E3',
      'Intentional non-work activity with a purpose: messaging friends and family, managing finances, booking travel, errands, life admin, and hobbies'
    ]
  ],
  'Founder / Executive': [
    ['Engineering / Product', '#6A7EFF', 'Coding, design work, shipping features, and hands-on building'],
    ['Research & Strategy', '#56CFEE', 'Competitive research, positioning, long-form thinking, and investor prep'],
    ['Data & Insights', '#C787F7', 'Dashboards, retention data, funnels, and financials'],
    ['Communication', '#FFAE8C', 'Team syncs, investor calls, user demos, and hiring'],
    [
      'Distraction',
      '#FF4721',
      'Unfocused browsing and passive content consumption: social media feeds, random videos, idle scrolling, entertainment with no clear intent, and gaming'
    ],
    [
      'Personal',
      '#ADE3E3',
      'Intentional non-work activity with a purpose: messaging friends and family, managing finances, booking travel, errands, life admin, and hobbies'
    ]
  ],
  Designer: [
    ['Design', '#6A7EFF', 'Prototyping, UI components, user flows, visual design, and handoff specs'],
    ['Research', '#56CFEE', 'Browsing patterns, competitive audits, user studies, and reviewing metrics'],
    ['Communication', '#FFAE8C', 'Design reviews, standups, critique sessions, and presenting concepts'],
    [
      'Distraction',
      '#FF4721',
      'Unfocused browsing and passive content consumption: social media feeds, random videos, idle scrolling, entertainment with no clear intent, and gaming'
    ],
    [
      'Personal',
      '#ADE3E3',
      'Intentional non-work activity with a purpose: messaging friends and family, managing finances, booking travel, errands, life admin, and hobbies'
    ]
  ],
  Student: [
    ['Studying', '#6A7EFF', 'Lectures, reading, reviewing slides, flashcards, and course material'],
    ['Assignments', '#56CFEE', 'Papers, problem sets, coding projects, and lab reports'],
    ['Communication', '#FFAE8C', 'Study groups, office hours, group chats, and emailing professors'],
    [
      'Distraction',
      '#FF4721',
      'Unfocused browsing and passive content consumption: social media feeds, random videos, idle scrolling, entertainment with no clear intent, and gaming'
    ],
    [
      'Personal',
      '#ADE3E3',
      'Intentional non-work activity with a purpose: messaging friends and family, managing finances, booking travel, errands, life admin, and hobbies'
    ]
  ],
  'Product Manager': [
    ['Specs & Planning', '#6A7EFF', 'PRDs, roadmaps, backlog grooming, sprint planning, and tickets'],
    ['Research & Analysis', '#56CFEE', 'User research, metrics review, competitive analysis, and A/B tests'],
    ['Communication', '#FFAE8C', 'Standups, stakeholder syncs, design reviews, and engineering check-ins'],
    [
      'Distraction',
      '#FF4721',
      'Unfocused browsing and passive content consumption: social media feeds, random videos, idle scrolling, entertainment with no clear intent, and gaming'
    ],
    [
      'Personal',
      '#ADE3E3',
      'Intentional non-work activity with a purpose: messaging friends and family, managing finances, booking travel, errands, life admin, and hobbies'
    ]
  ],
  'Data Scientist': [
    ['Analysis & Modeling', '#6A7EFF', 'Notebooks, statistical analysis, ML training, and data exploration'],
    ['Data Engineering', '#56CFEE', 'SQL queries, pipelines, data cleaning, and ETL scripts'],
    ['Research', '#C787F7', 'Reading papers, docs, and exploring new methods and tools'],
    ['Communication', '#FFAE8C', 'Presenting findings, stakeholder syncs, and team discussions'],
    [
      'Distraction',
      '#FF4721',
      'Unfocused browsing and passive content consumption: social media feeds, random videos, idle scrolling, entertainment with no clear intent, and gaming'
    ],
    [
      'Personal',
      '#ADE3E3',
      'Intentional non-work activity with a purpose: messaging friends and family, managing finances, booking travel, errands, life admin, and hobbies'
    ]
  ],
  Other: []
}

export function presetCategoriesForRole(role: string): Omit<TimelineCategory, 'id'>[] {
  const defs = ROLE_PRESETS[role] ?? ROLE_PRESETS['Other']
  const base: Omit<TimelineCategory, 'id'>[] = defs.map(([name, colorHex, details], i) => ({
    name,
    colorHex,
    details,
    order: i,
    isSystem: false,
    isIdle: false
  }))
  if (base.length === 0) {
    return structuredClone(DEFAULT_CATEGORIES.filter((c) => c.name === 'Idle'))
      .map((c) => ({ ...c, order: 0 }))
      .concat(
        structuredClone(DEFAULT_CATEGORIES.filter((c) => c.name !== 'Idle')).map((c, i) => ({
          ...c,
          order: i
        }))
      )
  }
  return base
}

export function getCategories(): TimelineCategory[] {
  const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [CATEGORIES_KEY])
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as TimelineCategory[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return ensureIdle(parsed)
      }
    } catch {
      // fall through to defaults
    }
  }
  const fresh = DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat-${i}` }))
  return fresh
}

export function saveCategories(categories: TimelineCategory[]): TimelineCategory[] {
  const withIdle = ensureIdle(categories)
  db.run(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
    [CATEGORIES_KEY, JSON.stringify(withIdle)]
  )
  return withIdle
}

function ensureIdle(categories: TimelineCategory[]): TimelineCategory[] {
  const sorted = [...categories].sort((a, b) => a.order - b.order)
  if (sorted.some((c) => c.isIdle)) return sorted
  const maxOrder = sorted.length ? Math.max(...sorted.map((c) => c.order)) : -1
  sorted.push({
    id: 'cat-idle',
    name: 'Idle',
    colorHex: '#A0AEC0',
    details: 'Mark sessions where the user is idle for most of the time.',
    order: maxOrder + 1,
    isSystem: true,
    isIdle: true
  })
  return sorted
}

export function isOnboarded(): boolean {
  const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [ONBOARDING_KEY])
  return row?.value === '1'
}

export function markOnboarded(): void {
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [ONBOARDING_KEY, '1'])
}
