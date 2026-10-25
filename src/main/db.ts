import initSqlJs, { type Database, type Statement } from 'sql.js'
import fs from 'fs'
import path from 'path'
import { getDbPath } from './paths'
import { TODO_SCHEMA_SQL } from './todo/schema'

/**
 * sql.js keeps the whole database in memory; we flush to disk after writes
 * (debounced + on quit). Volumes here are small (text cards + screenshot
 * metadata), so a full export per flush is fine and avoids any native build
 * dependency, keeping `npm install` guaranteed to work on Windows.
 */
class DB {
  private db: Database | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private dirty = false

  async init(): Promise<void> {
    const SQL = await initSqlJs()
    const file = getDbPath()
    if (fs.existsSync(file)) {
      try {
        this.db = new SQL.Database(fs.readFileSync(file))
      } catch {
        this.db = new SQL.Database()
      }
    } else {
      this.db = new SQL.Database()
    }
    this.migrate()
  }

  private migrate(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS screenshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          idle_seconds INTEGER,
          is_private INTEGER DEFAULT 0,
          is_deleted INTEGER DEFAULT 0,
          created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at);

      CREATE TABLE IF NOT EXISTS analysis_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_start_ts INTEGER NOT NULL,
          batch_end_ts INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT,
          llm_metadata TEXT,
          created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_batches_status ON analysis_batches(status);

      CREATE TABLE IF NOT EXISTS batch_screenshots (
          batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
          screenshot_id INTEGER NOT NULL,
          PRIMARY KEY (batch_id, screenshot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_batch_screenshots_screenshot ON batch_screenshots(screenshot_id);

      CREATE TABLE IF NOT EXISTS timeline_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER,
          start TEXT NOT NULL,
          end TEXT NOT NULL,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          day TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT,
          category TEXT NOT NULL,
          subcategory TEXT,
          detailed_summary TEXT,
          metadata TEXT,
          created_at INTEGER,
          is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_cards_day ON timeline_cards(day);
      CREATE INDEX IF NOT EXISTS idx_timeline_cards_start_ts ON timeline_cards(start_ts);

      CREATE TABLE IF NOT EXISTS daily_standup_entries (
          standup_day TEXT NOT NULL PRIMARY KEY,
          payload_json TEXT NOT NULL,
          created_at INTEGER,
          updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS day_plans (
          day TEXT NOT NULL PRIMARY KEY,
          priorities_json TEXT,
          blockers TEXT,
          updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS llm_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER,
          provider TEXT NOT NULL,
          model TEXT,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          latency_ms INTEGER,
          error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_conversations (
          id TEXT NOT NULL PRIMARY KEY,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sort_order INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
          ON chat_messages(conversation_id, sort_order);

      CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
      );

      -- Timing-style entities (window-title-first tracking) ----------------

      CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES projects(id),
          title TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#e8763a',
          productivity_score REAL NOT NULL DEFAULT 0,
          billable_by_default INTEGER NOT NULL DEFAULT 0,
          list_position INTEGER NOT NULL DEFAULT 0,
          is_deleted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          conditions_json TEXT NOT NULL,
          list_position INTEGER NOT NULL DEFAULT 0,
          is_deleted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS app_activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          app_name TEXT NOT NULL,
          title TEXT,
          url_or_path TEXT,
          project_id INTEGER REFERENCES projects(id),
          is_manual INTEGER NOT NULL DEFAULT 0,
          card_id INTEGER,
          is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_app_activities_start ON app_activities(start_ts);
      CREATE INDEX IF NOT EXISTS idx_app_activities_project ON app_activities(project_id);

      CREATE TABLE IF NOT EXISTS task_activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER,
          title TEXT NOT NULL,
          notes TEXT,
          project_id INTEGER REFERENCES projects(id),
          billable INTEGER NOT NULL DEFAULT 0,
          is_deleted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS classifications (
          app_name TEXT NOT NULL,
          title_pattern TEXT NOT NULL,
          project_id INTEGER NOT NULL,
          hits INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER,
          PRIMARY KEY (app_name, title_pattern)
      );

      -- 学习守护（常驻 Agent）：打断/提醒事件史 + 今日累计 -----

      CREATE TABLE IF NOT EXISTS tutor_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          app_name TEXT,
          title TEXT,
          detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tutor_events_ts ON tutor_events(ts);

      CREATE TABLE IF NOT EXISTS tutor_daily (
          day TEXT NOT NULL,
          focus_ms INTEGER NOT NULL DEFAULT 0,
          dev_ms INTEGER NOT NULL DEFAULT 0,
          interrupt_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER,
          PRIMARY KEY (day)
      );
    `)
    // 迁移：无输入标记列
    try {
      this.db!.exec('ALTER TABLE app_activities ADD COLUMN is_idle INTEGER NOT NULL DEFAULT 0')
    } catch {
      // 列已存在
    }
    // 任务域（EpochToDo 融合）：tasks/task_projects/timers/history/gpus
    this.db!.exec(TODO_SCHEMA_SQL)
    this.dirty = true
    this.flush()
  }

  prepare(sql: string): Statement {
    if (!this.db) throw new Error('database not initialized')
    return this.db.prepare(sql)
  }

  /** Run a write statement and schedule a flush. */
  run(sql: string, params: unknown[] = []): void {
    const stmt = this.prepare(sql)
    try {
      stmt.run(params as never)
    } finally {
      stmt.free()
    }
    this.dirty = true
    this.scheduleFlush()
  }

  /** Run multiple write statements in one go (single flush). */
  runMany(statements: { sql: string; params?: unknown[] }[]): void {
    for (const { sql, params = [] } of statements) {
      const stmt = this.prepare(sql)
      try {
        stmt.run(params as never)
      } finally {
        stmt.free()
      }
    }
    this.dirty = true
    this.scheduleFlush()
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.prepare(sql)
    const rows: T[] = []
    try {
      stmt.bind(params as never)
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
    } finally {
      stmt.free()
    }
    return rows
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  count(sql: string, params: unknown[] = []): number {
    const row = this.get<{ c: number }>(sql, params)
    return row ? Number(row.c) : 0
  }

  exec(sql: string): void {
    this.db!.exec(sql)
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 2000)
  }

  flush(): void {
    if (!this.db || !this.dirty) return
    const file = getDbPath()
    const tmp = file + '.tmp'
    try {
      const data = Buffer.from(this.db.export())
      fs.writeFileSync(tmp, data)
      fs.renameSync(tmp, file)
      this.dirty = false
    } catch (err) {
      console.error('[db] flush failed:', err)
    }
  }

  close(): void {
    this.flush()
    this.db?.close()
    this.db = null
  }
}

export const db = new DB()

export function nowTs(): number {
  return Date.now()
}
