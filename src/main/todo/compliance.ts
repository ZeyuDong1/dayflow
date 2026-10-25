/**
 * 任务会话合规比例分析（功能清单 §九）。
 * 对每个专注会话取区间内截图样本，判定"用户是否在执行该任务"，
 * 合规比例 = 在做该任务的样本数 / 总样本数，结果缓存入库（一次分析不重复花 LLM）。
 *
 * - LLM 判定经 SessionJudge 注入（装配层接现有 AI provider 管线；测试注入假实现），本模块不接真实 provider。
 * - 截图样本由调用方查询 screenshots 表（captured_at/file_path）拼好传入，本模块不直接查截图表（保持可测）。
 * - 建表由装配层执行 COMPLIANCE_SCHEMA_SQL（与 TODO_SCHEMA_SQL 同机制，本模块不改 db.ts）。
 */
import type { TodoDB } from './db'

export const COMPLIANCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_session_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      history_id INTEGER NOT NULL,
      analyzed_at INTEGER NOT NULL,
      sample_count INTEGER NOT NULL,
      on_task_count INTEGER NOT NULL,
      ratio REAL NOT NULL,
      detail TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_task_session_analysis_history ON task_session_analysis(history_id);
`

/** 截图样本（对应 screenshots 表一行的 captured_at/file_path）。 */
export interface SessionSample {
  capturedAt: number
  filePath: string
}

export interface SessionJudgeInput {
  taskTitle: string
  startTs: number
  endTs: number
  samples: SessionSample[]
}

export interface SessionJudgeOutput {
  onTaskCount: number
  detail?: string
}

/** LLM 判定注入点：给定会话与样本，返回"在做该任务"的样本数与可选证据摘要。 */
export type SessionJudge = (input: SessionJudgeInput) => Promise<SessionJudgeOutput>

/** task_session_analysis 缓存行。 */
export interface SessionAnalysis {
  id: number
  historyId: number
  analyzedAt: number
  sampleCount: number
  onTaskCount: number
  ratio: number
  detail: string | null
}

/** listAnalyses 返回：缓存行 + history 联表字段（时间轴泳道定位与详情用）。 */
export interface SessionAnalysisWithHistory extends SessionAnalysis {
  title: string
  startTime: string
  endTime: string
}

export interface AnalyzeSessionDeps {
  db: TodoDB
  judge: SessionJudge
  now: () => number
}

export interface AnalyzeSessionInput {
  historyId: number
  taskTitle: string
  startTs: number
  endTs: number
  samples: SessionSample[]
}

export interface AnalyzeSessionResult {
  ratio: number | null
  sampleCount: number
  onTaskCount: number
}

/** 单次会话最多送判样本数（抽样密度）。 */
const DEFAULT_MAX_SAMPLES = 8
/** 会话时长下限：与 focus 结算的 180 秒记账门槛对齐（语义规格 §2.3）。 */
const MIN_SESSION_MS = 180 * 1000

/**
 * 取区间内样本（[startTs, endTs] 闭区间，区间外剔除）、按时间升序、等距抽样至多 max 张。
 * 等距抽样含首尾（会话起止时刻的证据最关键）；max=1 时取中位样本。
 */
export function sampleSession(samples: SessionSample[], startTs: number, endTs: number, max = DEFAULT_MAX_SAMPLES): SessionSample[] {
  const inRange = samples
    .filter((s) => s.capturedAt >= startTs && s.capturedAt <= endTs)
    .sort((a, b) => a.capturedAt - b.capturedAt)
  if (max <= 0) return []
  if (inRange.length <= max) return inRange
  if (max === 1) return [inRange[Math.floor((inRange.length - 1) / 2)]]
  const step = (inRange.length - 1) / (max - 1)
  const picked: SessionSample[] = []
  for (let i = 0; i < max; i++) picked.push(inRange[Math.round(i * step)])
  return picked
}

/**
 * 会话合规分析：样本为 0 或会话 <180 秒 → ratio=null（不写库不调 judge）；
 * 命中缓存（task_session_analysis 已有 history_id 行）→ 直接返回缓存；
 * 否则调 judge，onTaskCount clamp 到 [0, sampleCount]，ratio = onTaskCount / sampleCount，写库返回。
 */
export async function analyzeSession(deps: AnalyzeSessionDeps, input: AnalyzeSessionInput): Promise<AnalyzeSessionResult> {
  const sessionMs = input.endTs - input.startTs
  const picked = sampleSession(input.samples, input.startTs, input.endTs)
  if (picked.length === 0 || sessionMs < MIN_SESSION_MS) {
    return { ratio: null, sampleCount: 0, onTaskCount: 0 }
  }
  const cached = getAnalysis(deps.db, input.historyId)
  if (cached) {
    return { ratio: cached.ratio, sampleCount: cached.sampleCount, onTaskCount: cached.onTaskCount }
  }
  const judged = await deps.judge({
    taskTitle: input.taskTitle,
    startTs: input.startTs,
    endTs: input.endTs,
    samples: picked,
  })
  const sampleCount = picked.length
  const onTaskCount = clampCount(judged.onTaskCount, sampleCount)
  const ratio = onTaskCount / sampleCount
  deps.db.run(
    `INSERT INTO task_session_analysis (history_id, analyzed_at, sample_count, on_task_count, ratio, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.historyId, deps.now(), sampleCount, onTaskCount, ratio, judged.detail ?? null],
  )
  return { ratio, sampleCount, onTaskCount }
}

/** 读缓存（未分析过返回 undefined）。 */
export function getAnalysis(db: TodoDB, historyId: number): SessionAnalysis | undefined {
  const row = db.get<AnalysisRow>('SELECT * FROM task_session_analysis WHERE history_id = ? ORDER BY id DESC LIMIT 1', [
    historyId,
  ])
  return row ? mapAnalysis(row) : undefined
}

/** 当日全部分析（按 history.start_time 日前缀过滤），供时间轴泳道用；按会话开始时间升序。 */
export function listAnalyses(db: TodoDB, day: string): SessionAnalysisWithHistory[] {
  const rows = db.all<AnalysisRow & { title: string; start_time: string; end_time: string }>(
    `SELECT a.id, a.history_id, a.analyzed_at, a.sample_count, a.on_task_count, a.ratio, a.detail,
            h.title AS title, h.start_time AS start_time, h.end_time AS end_time
     FROM task_session_analysis a
     JOIN history h ON h.id = a.history_id
     WHERE h.start_time LIKE ?
     ORDER BY h.start_time ASC, h.id ASC`,
    [`${day}%`],
  )
  return rows.map((r) => ({
    ...mapAnalysis(r),
    title: r.title,
    startTime: r.start_time,
    endTime: r.end_time,
  }))
}

function clampCount(value: number, sampleCount: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), sampleCount)
}

interface AnalysisRow {
  id: number
  history_id: number
  analyzed_at: number
  sample_count: number
  on_task_count: number
  ratio: number
  detail: string | null
}

function mapAnalysis(row: AnalysisRow): SessionAnalysis {
  return {
    id: row.id,
    historyId: row.history_id,
    analyzedAt: row.analyzed_at,
    sampleCount: row.sample_count,
    onTaskCount: row.on_task_count,
    ratio: row.ratio,
    detail: row.detail,
  }
}
