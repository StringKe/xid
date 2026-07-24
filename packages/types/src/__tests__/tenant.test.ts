import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SESSION_POLICY,
  DEFAULT_TOKEN_POLICY,
  normalizeSessionPolicy,
  normalizeTokenPolicy,
} from '../tenant'

describe('normalizeSessionPolicy', () => {
  it.each([undefined, null, {}, 'x', 42])(
    'returns defaults for empty/unknown input: %s',
    (input) => {
      expect(normalizeSessionPolicy(input)).toEqual({
        idleTimeoutMin: 4320,
        absoluteTimeoutDays: 30,
      })
    },
  )

  it('keeps provided fields and falls back missing fields to defaults', () => {
    expect(normalizeSessionPolicy({ idleTimeoutMin: 60 })).toEqual({
      idleTimeoutMin: 60,
      absoluteTimeoutDays: DEFAULT_SESSION_POLICY.absoluteTimeoutDays,
    })
  })

  it('clamps out-of-range values to bounds', () => {
    expect(normalizeSessionPolicy({ idleTimeoutMin: 1 }).idleTimeoutMin).toBe(5)
    expect(normalizeSessionPolicy({ idleTimeoutMin: 99999 }).idleTimeoutMin).toBe(43200)
    expect(normalizeSessionPolicy({ absoluteTimeoutDays: 0 }).absoluteTimeoutDays).toBe(1)
    expect(normalizeSessionPolicy({ absoluteTimeoutDays: 999 }).absoluteTimeoutDays).toBe(365)
  })

  it('falls back to defaults for non-number fields', () => {
    expect(normalizeSessionPolicy({ idleTimeoutMin: '60' }).idleTimeoutMin).toBe(4320)
    expect(normalizeSessionPolicy({ idleTimeoutMin: Number.NaN }).idleTimeoutMin).toBe(4320)
    expect(normalizeSessionPolicy({ absoluteTimeoutDays: true }).absoluteTimeoutDays).toBe(30)
  })

  it('passes through boolean rememberMeDefault and omits invalid values', () => {
    expect(normalizeSessionPolicy({ rememberMeDefault: true }).rememberMeDefault).toBe(true)
    expect(normalizeSessionPolicy({ rememberMeDefault: false }).rememberMeDefault).toBe(false)
    expect(normalizeSessionPolicy({ rememberMeDefault: 'yes' })).not.toHaveProperty(
      'rememberMeDefault',
    )
  })

  it('accepts snake_case keys from DB JSON columns', () => {
    expect(normalizeSessionPolicy({ idle_timeout_min: 120, absolute_timeout_days: 10 })).toEqual({
      idleTimeoutMin: 120,
      absoluteTimeoutDays: 10,
    })
  })
})

describe('normalizeTokenPolicy', () => {
  it.each([undefined, null, {}, 'x', 42])(
    'returns defaults for empty/unknown input: %s',
    (input) => {
      expect(normalizeTokenPolicy(input)).toEqual({
        accessTokenTtlSec: 3600,
        sessionTokenTtlSec: 60,
        refreshIdleTimeoutDays: 30,
        refreshAbsoluteTimeoutDays: 7,
      })
    },
  )

  it('keeps provided fields and falls back missing fields to defaults', () => {
    expect(normalizeTokenPolicy({ accessTokenTtlSec: 120 })).toEqual({
      accessTokenTtlSec: 120,
      sessionTokenTtlSec: DEFAULT_TOKEN_POLICY.sessionTokenTtlSec,
      refreshIdleTimeoutDays: DEFAULT_TOKEN_POLICY.refreshIdleTimeoutDays,
      refreshAbsoluteTimeoutDays: DEFAULT_TOKEN_POLICY.refreshAbsoluteTimeoutDays,
    })
  })

  it('clamps out-of-range values to bounds', () => {
    expect(normalizeTokenPolicy({ accessTokenTtlSec: 10 }).accessTokenTtlSec).toBe(60)
    expect(normalizeTokenPolicy({ accessTokenTtlSec: 999999 }).accessTokenTtlSec).toBe(86400)
    expect(normalizeTokenPolicy({ sessionTokenTtlSec: 10 }).sessionTokenTtlSec).toBe(30)
    expect(normalizeTokenPolicy({ sessionTokenTtlSec: 999 }).sessionTokenTtlSec).toBe(300)
    expect(normalizeTokenPolicy({ refreshIdleTimeoutDays: 0 }).refreshIdleTimeoutDays).toBe(1)
    expect(normalizeTokenPolicy({ refreshIdleTimeoutDays: 999 }).refreshIdleTimeoutDays).toBe(365)
    expect(normalizeTokenPolicy({ refreshAbsoluteTimeoutDays: 0 }).refreshAbsoluteTimeoutDays).toBe(
      1,
    )
    expect(
      normalizeTokenPolicy({ refreshAbsoluteTimeoutDays: 999 }).refreshAbsoluteTimeoutDays,
    ).toBe(90)
  })

  it('falls back to defaults for non-number fields', () => {
    expect(normalizeTokenPolicy({ accessTokenTtlSec: '120' }).accessTokenTtlSec).toBe(3600)
    expect(
      normalizeTokenPolicy({ refreshIdleTimeoutDays: Number.NaN }).refreshIdleTimeoutDays,
    ).toBe(30)
  })

  it('accepts snake_case keys from DB JSON columns', () => {
    expect(
      normalizeTokenPolicy({
        access_token_ttl_sec: 120,
        session_token_ttl_sec: 45,
        refresh_idle_timeout_days: 10,
        refresh_absolute_timeout_days: 3,
      }),
    ).toEqual({
      accessTokenTtlSec: 120,
      sessionTokenTtlSec: 45,
      refreshIdleTimeoutDays: 10,
      refreshAbsoluteTimeoutDays: 3,
    })
  })
})
