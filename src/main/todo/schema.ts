/**
 * 任务域（EpochToDo 融合）建表 SQL。
 * db.ts 的 migrate() 与 tests/helpers/memdb.ts 共用，保证两侧 schema 一致。
 * 时间戳一律 ISO 文本（与语义规格 §1.2 对齐）；不做 dispatched_target（跨应用分发已移除）。
 */
export const TODO_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      type TEXT NOT NULL DEFAULT 'standard',
      context_memo TEXT,
      total_duration INTEGER NOT NULL DEFAULT 0,
      estimated_duration INTEGER,
      tag TEXT,
      project_id INTEGER,
      parent_id INTEGER,
      is_next_action INTEGER NOT NULL DEFAULT 0,
      is_side_focus INTEGER NOT NULL DEFAULT 0,
      side_focus_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      gpu_id INTEGER,
      last_focused_at TEXT,
      created_at TEXT NOT NULL,
      is_webhook INTEGER NOT NULL DEFAULT 0,
      md_file_path TEXT,
      md_line_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS timers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      target_timestamp TEXT,
      original_duration INTEGER,
      started_at TEXT
  );

  CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_id TEXT,
      color TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT
  );
`
