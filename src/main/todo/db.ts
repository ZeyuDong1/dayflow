/**
 * 任务域对数据库的最小结构化接口——现有 db.ts 的 DB 类天然满足；
 * 测试用 tests/helpers/memdb.ts 的内存实现注入。
 */
export interface TodoDB {
  run(sql: string, params?: unknown[]): void
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined
}
