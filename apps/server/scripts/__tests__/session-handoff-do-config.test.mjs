import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const wrangler = read('../../wrangler.jsonc')
const workerMain = read('../../worker/index.ts')
const durableObjectIndex = read('../../worker/durable-objects/index.ts')
const workerEnv = read('../../worker/env.d.ts')
const publicServerEnv = read('../../../../packages/types/src/cloudflare.d.ts')

describe('session handoff Durable Object configuration', () => {
  it('binds and migrates the SQLite-backed one-time handoff namespace under tag v5', () => {
    expect(wrangler).toContain('{ "name": "SESSION_HANDOFF", "class_name": "SessionHandoffDO" }')
    expect(wrangler).toMatch(
      /"tag"\s*:\s*"v5"[\s\S]*?"new_sqlite_classes"\s*:\s*\["SessionHandoffDO"\]/u,
    )
  })

  it('exports the class from the Worker main module and declares its Env binding', () => {
    expect(durableObjectIndex).toContain("export { SessionHandoffDO } from './session-handoff-do'")
    expect(workerMain).toMatch(
      /export\s*\{[\s\S]*?\bSessionHandoffDO\b[\s\S]*?\}\s*from '\.\/durable-objects'/u,
    )
    expect(workerEnv).toContain('SESSION_HANDOFF: DurableObjectNamespace')
    expect(publicServerEnv).toContain('SESSION_HANDOFF: DurableObjectNamespace')
  })
})
