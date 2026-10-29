/**
 * 监督豁免条目(agent 审批的页面级白名单):
 * 用户在聊天里请求"把 X 算作学习",导师小舟核实应用数据后同意/拒绝;
 * 同意即输出协议指令,由本模块服务端执行——模型只提议,策略全部服务端强制(OWASP):
 * - 冷却期:新增 10 分钟后才生效(防冲动套利);
 * - 每日配额:每天最多批 5 条(注入/滥用熔断);
 * - 自动过期:7 天失效,需重新申请(防无人看管期滥用);
 * - 粒度:仅标题/应用关键词,不触碰类型级 allowedProjectIds(类型级曾出过全放行事故);
 * - 全程留痕:tutor_events + 聊天内可见确认,用户可申诉、可在设置页手动撤销。
 * - 数据复核:关键词近 7 天匹配的活动若 60% 以上时长落在低效率分(≤3,游戏/娱乐)
 *   类型,服务端直接拒绝——"Warframe 攻略"这类包装骗得过模型骗不过数据。
 */
import { db } from './db'
import { todayKey } from './paths'

const STORE_KEY = 'supervisor-allowances'
const COOLDOWN_MS = 10 * 60_000
const EXPIRE_MS = 7 * 86400_000
const DAILY_QUOTA = 5
const MAX_ACTIVE = 20

export type AllowanceField = 'title' | 'app'

export interface Allowance {
  id: number
  field: AllowanceField
  value: string
  reason: string
  createdAtTs: number
  effectiveAtTs: number
  expiresAtTs: number
  revokedAtTs?: number
  revokedBy?: 'agent' | 'user' | 'auto-expire'
  revokeReason?: string
}

interface Store {
  entries: Allowance[]
  quotaDay: string
  quotaUsed: number
  nextId: number
}

let store: Store = { entries: [], quotaDay: '', quotaUsed: 0, nextId: 1 }
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const row = db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [STORE_KEY])
    if (row) store = { ...store, ...(JSON.parse(row.value) as Partial<Store>) }
  } catch {
    // 首次无记录
  }
}

function persist(): void {
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [STORE_KEY, JSON.stringify(store)])
}

function logEvent(type: string, detail: string): void {
  try {
    db.run('INSERT INTO tutor_events (ts, type, app_name, title, detail) VALUES (?, ?, ?, ?, ?)', [
      Date.now(),
      type,
      null,
      null,
      detail
    ])
  } catch {
    // 表未迁移时忽略
  }
}

function isActive(a: Allowance): boolean {
  return (
    !a.revokedAtTs &&
    Date.now() >= a.effectiveAtTs &&
    Date.now() <= a.expiresAtTs
  )
}

/** 到期清扫:过期条目标记 auto-expire(留痕可查)。 */
export function allowanceExpireSweep(): void {
  load()
  let changed = false
  for (const a of store.entries) {
    if (!a.revokedAtTs && Date.now() > a.expiresAtTs) {
      a.revokedAtTs = Date.now()
      a.revokedBy = 'auto-expire'
      a.revokeReason = '7 天有效期到,自动过期'
      logEvent('allowance-expire', `${a.field}:${a.value}`)
      changed = true
    }
  }
  if (changed) persist()
}

export interface AddResult {
  ok: boolean
  error?: string
  entry?: Allowance
}

/** agent 审批通过后的服务端执行:全部硬约束在这里,模型无法绕过。 */
export function allowanceAddByAgent(field: AllowanceField, value: string, reason: string): AddResult {
  load()
  allowanceExpireSweep()
  const v = (value ?? '').trim()
  const why = (reason ?? '').trim().slice(0, 120)
  if (field !== 'title' && field !== 'app') return { ok: false, error: '字段只支持 title/app' }
  if (v.length < 2 || v.length > 80) return { ok: false, error: '关键词长度需在 2-80 之间' }
  const active = store.entries.filter(isActive)
  if (active.length >= MAX_ACTIVE) return { ok: false, error: '生效中的豁免已达上限(20 条)' }
  if (active.some((a) => a.field === field && a.value.toLowerCase() === v.toLowerCase())) {
    return { ok: false, error: '已存在相同豁免' }
  }
  // 数据复核(防话术):近 7 天匹配该关键词的活动若主要由低效率分类型构成,拒绝。
  // 足量证据(≥10 分钟)才触发;新页面无历史时仍由 agent 判断。
  const since = Date.now() - 7 * 86400_000
  const like = `%${v.replace(/[\\%_]/g, (m) => '\\' + m)}%`
  const evRows =
    field === 'app'
      ? db.all<{ project_id: number | null; ms: number }>(
          `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
           WHERE is_deleted = 0 AND is_idle = 0 AND start_ts >= ? AND app_name LIKE ? ESCAPE '\\'
           GROUP BY project_id`,
          [since, like]
        )
      : db.all<{ project_id: number | null; ms: number }>(
          `SELECT project_id, SUM(end_ts - start_ts) AS ms FROM app_activities
           WHERE is_deleted = 0 AND is_idle = 0 AND start_ts >= ? AND title LIKE ? ESCAPE '\\'
           GROUP BY project_id`,
          [since, like]
        )
  const evTotal = evRows.reduce((a, r) => a + r.ms, 0)
  if (evTotal >= 10 * 60_000) {
    const scoreOf = (id: number | null): number =>
      id == null
        ? 4
        : (db.get<{ productivity_score: number }>('SELECT productivity_score FROM projects WHERE id = ?', [
            id
          ])?.productivity_score ?? 4)
    const lowMs = evRows.reduce((a, r) => a + (scoreOf(r.project_id) <= 3 ? r.ms : 0), 0)
    if (lowMs / evTotal >= 0.6) {
      const pct = Math.round((lowMs / evTotal) * 100)
      logEvent('allowance-reject-data', `${field}:${v} · 低效率占比 ${pct}%`)
      return {
        ok: false,
        error: `数据核实不通过:该关键词近 7 天的活动 ${pct}% 属于低效率分类型(游戏/娱乐等),不能加入学习白名单`
      }
    }
  }

  const day = todayKey()
  if (store.quotaDay !== day) {
    store.quotaDay = day
    store.quotaUsed = 0
  }
  if (store.quotaUsed >= DAILY_QUOTA) {
    return { ok: false, error: '今日白名单审批额度已用完(5 条/天)' }
  }
  store.quotaUsed += 1
  const entry: Allowance = {
    id: store.nextId++,
    field,
    value: v,
    reason: why || '(未给出理由)',
    createdAtTs: Date.now(),
    effectiveAtTs: Date.now() + COOLDOWN_MS,
    expiresAtTs: Date.now() + EXPIRE_MS
  }
  store.entries.push(entry)
  persist()
  logEvent('allowance-add', `${field}:${v} · ${why}`)
  return { ok: true, entry }
}

/** 撤销(agent 主动发现滥用,或用户在设置页手动撤销)。 */
export function allowanceRevoke(id: number, by: 'agent' | 'user', reason: string): { ok: boolean; error?: string } {
  load()
  const a = store.entries.find((x) => x.id === id && !x.revokedAtTs)
  if (!a) return { ok: false, error: '条目不存在或已撤销' }
  a.revokedAtTs = Date.now()
  a.revokedBy = by
  a.revokeReason = (reason ?? '').trim().slice(0, 120) || (by === 'user' ? '用户手动撤销' : '')
  persist()
  logEvent('allowance-remove', `${a.field}:${a.value} · by ${by} · ${a.revokeReason}`)
  return { ok: true }
}

/** judge() 用:当前前台是否命中生效中的豁免(冷却期未到/已过期不匹配)。 */
export function matchAllowance(appName: string, title: string): Allowance | null {
  load()
  allowanceExpireSweep()
  const t = (title ?? '').toLowerCase()
  const a0 = (appName ?? '').toLowerCase()
  for (const a of store.entries) {
    if (!isActive(a)) continue
    const hit = a.field === 'app' ? a0.includes(a.value.toLowerCase()) : t.includes(a.value.toLowerCase())
    if (hit) return a
  }
  return null
}

/** 设置面板用:最近条目(含已撤销/过期,留痕透明)。 */
export function allowanceList(): Allowance[] {
  load()
  allowanceExpireSweep()
  return [...store.entries].sort((a, b) => b.id - a.id).slice(0, 50)
}

/** 聊天系统提示注入:当前生效中的豁免清单。 */
export function allowanceChatContext(): string {
  load()
  allowanceExpireSweep()
  const active = store.entries.filter(isActive)
  if (active.length === 0) return '(当前没有生效中的学习白名单豁免)'
  return active
    .map((a) => {
      const until = new Date(a.expiresAtTs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      return `- #${a.id} ${a.field === 'app' ? '应用' : '标题'}含「${a.value}」(理由:${a.reason};${until} 过期)`
    })
    .join('\n')
}
