import { describe, expect, it } from 'vitest'
import {
  createPersistedId,
  isPersistedId,
  PERSISTED_ID_PREFIXES,
  type PersistedIdKind,
} from '../persisted-id'

describe('persisted entity IDs', () => {
  it('uses every design 9.6 prefix with a 21-character base62 suffix', () => {
    for (const kind of Object.keys(PERSISTED_ID_PREFIXES) as PersistedIdKind[]) {
      const id = createPersistedId(kind)
      expect(id).toMatch(new RegExp(`^${PERSISTED_ID_PREFIXES[kind]}[A-Za-z0-9]{21}$`))
      expect(isPersistedId(kind, id)).toBe(true)
    }
  })

  it('provides enough independent entropy for identifiers generated in one isolate', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => createPersistedId('user')))
    expect(ids.size).toBe(1_000)
  })

  it('does not accept a legacy UUID or another entity prefix as a current ID', () => {
    expect(isPersistedId('user', '3f6c9f6e-2a1b-4c5d-8e9f-0a1b2c3d4e5f')).toBe(false)
    expect(isPersistedId('user', createPersistedId('session'))).toBe(false)
  })
})
