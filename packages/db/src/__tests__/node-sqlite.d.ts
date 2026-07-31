declare module 'node:sqlite' {
  export class StatementSync {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }

  export class DatabaseSync {
    constructor(location: string)
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}

declare module '*.sql?raw' {
  const sql: string
  export default sql
}
