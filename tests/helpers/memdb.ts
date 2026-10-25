/**
 * 测试用内存数据库：sql.js 空库 + app_settings + 任务域 schema。
 * 与生产 db.ts 共用 TODO_SCHEMA_SQL，保证两侧 schema 一致。
 */
import initSqlJs, { type Database } from 'sql.js'
import { TODO_SCHEMA_SQL } from '../../src/main/todo/schema'
import type { TodoDB } from '../../src/main/todo/db'

export interface MemDb extends TodoDB {
  exec(sql: string): void
}

class SqlJsMemDb implements MemDb {
  constructor(private db: Database) {}

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, params: unknown[] = []): void {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as never)
      stmt.step()
    } finally {
      stmt.free()
    }
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql)
    const rows: T[] = []
    try {
      stmt.bind(params as never)
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
    } finally {
      stmt.free()
    }
    return rows
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }
}

export async function createMemDb(): Promise<MemDb> {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
  db.exec(TODO_SCHEMA_SQL)
  return new SqlJsMemDb(db)
}
