import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path) {
  return readFileSync(path, 'utf8')
}

describe('runtime contract documentation', () => {
  it('documents the exact guest and sign-out response shapes', () => {
    const authentication = read('docs/design/01-authentication.md')
    const authenticationZh = read('docs/zh-Hans/design/01-authentication.md')
    const apiContracts = read('docs/api-contracts.md')

    for (const document of [authentication, authenticationZh]) {
      expect(document).toContain('{ sessionId, redirectUrl }')
      expect(document).toContain('/v1/me')
    }
    expect(apiContracts).toContain('returns HTTP 200 `{ ok: true }`')
    expect(apiContracts).not.toMatch(/\/auth\/sign-out[^\n]*`204`/u)
  })

  it('documents impersonation as an opaque handoff and restricted cookie', () => {
    const operations = read('docs/design/07-platform-operations.md')
    const operationsZh = read('docs/zh-Hans/design/07-platform-operations.md')

    expect(operations).toContain('two-minute, consume-once opaque handoff')
    expect(operations).toContain('15-minute')
    expect(operations).toContain('HttpOnly impersonation cookie')
    expect(operations).not.toContain('15-minute scoped token')

    expect(operationsZh).toContain('2min')
    expect(operationsZh).toContain('15min HttpOnly impersonation cookie')
    expect(operationsZh).not.toContain('15min scoped token')
  })
})
