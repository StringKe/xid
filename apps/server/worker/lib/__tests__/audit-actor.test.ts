import { describe, expect, it } from 'vitest'
import { auditActorDisplay, DELETED_AUDIT_ACTOR } from '../audit-actor'

describe('auditActorDisplay', () => {
  it('keeps resolvable and system actors unchanged', () => {
    expect(auditActorDisplay(null, { found: false, erasedAt: null })).toBeNull()
    expect(auditActorDisplay('system', { found: false, erasedAt: null })).toBe('system')
    expect(auditActorDisplay('user_active', { found: true, erasedAt: null })).toBe('user_active')
  })

  it('renders missing or erased identity mappings without rewriting actor_id', () => {
    expect(auditActorDisplay('user_missing', { found: false, erasedAt: null })).toBe(
      DELETED_AUDIT_ACTOR,
    )
    expect(
      auditActorDisplay('user_erased', {
        found: true,
        erasedAt: Date.parse('2026-07-28T00:00:00.000Z'),
      }),
    ).toBe(DELETED_AUDIT_ACTOR)
  })
})
