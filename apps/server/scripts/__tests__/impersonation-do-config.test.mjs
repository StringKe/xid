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

describe('impersonation Durable Object configuration', () => {
  it('binds and migrates the SQLite-backed one-time grant namespace', () => {
    expect(wrangler).toContain(
      '{ "name": "IMPERSONATION_GRANTS", "class_name": "ImpersonationGrantDO" }',
    )
    expect(wrangler).toMatch(
      /"tag"\s*:\s*"v4"[\s\S]*?"new_sqlite_classes"\s*:\s*\["ImpersonationGrantDO"\]/u,
    )
  })

  it('exports the class from the Worker main module and declares its Env binding', () => {
    expect(durableObjectIndex).toContain(
      "export { ImpersonationGrantDO } from './impersonation-grant-do'",
    )
    expect(workerMain).toMatch(
      /export\s*\{[\s\S]*?\bImpersonationGrantDO\b[\s\S]*?\}\s*from '\.\/durable-objects'/u,
    )
    expect(workerEnv).toContain('IMPERSONATION_GRANTS: DurableObjectNamespace')
    expect(publicServerEnv).toContain('IMPERSONATION_GRANTS: DurableObjectNamespace')
  })
})
