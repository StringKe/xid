// 真 SQLite 包装为 D1:stateful-d1 不支持 LIKE/JOIN,org-units 服务层测试须此实现。

import { DatabaseSync } from 'node:sqlite'

type SqliteRow = Record<string, unknown>

// node:sqlite 绑定:Date->ms,布尔->0/1。
function normalizeBinding(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  return value
}

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings.map(normalizeBinding)
    return this
  }

  execute(): D1Result<unknown> {
    const result = this.owner.database.prepare(this.sql).run(...(this.bindings as never[]))
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as unknown as D1Result<T>
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    const statement = this.owner.database.prepare(this.sql)
    return {
      success: true,
      results: statement.all(...(this.bindings as never[])) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>
  }

  async first<T = SqliteRow>(): Promise<T | null> {
    const statement = this.owner.database.prepare(this.sql)
    return (statement.get(...(this.bindings as never[])) as T | undefined) ?? null
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const statement = this.owner.database.prepare(this.sql)
    statement.setReturnArrays(true)
    try {
      return statement.all(...(this.bindings as never[])) as T[]
    } finally {
      statement.setReturnArrays(false)
    }
  }
}

export class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this, sql) as unknown as D1PreparedStatement
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteD1Statement).execute(),
      )
      this.database.exec('COMMIT')
      return results as D1Result<T>[]
    } catch (cause) {
      this.database.exec('ROLLBACK')
      throw cause
    }
  }

  close(): void {
    this.database.close()
  }
}
