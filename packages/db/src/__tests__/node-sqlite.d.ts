declare module 'node:sqlite' {
  export class StatementSync {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number | bigint }
    setReturnArrays(enabled: boolean): void
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

// packages/db tsconfig 只带 workers-types;测试读 migration 目录所需的最小 node 模块声明。
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: BufferEncoding): string
  export function readdirSync(path: string): string[]
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string
}

// 读 migration 目录需要 import.meta.url。
interface ImportMeta {
  readonly url: string
}
