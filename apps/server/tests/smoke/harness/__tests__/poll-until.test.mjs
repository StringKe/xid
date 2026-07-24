import { describe, expect, it } from 'vitest'
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, pollUntil } from '../poll-until.mjs'

function virtualClock() {
  let current = 0
  const sleeps = []
  return {
    clock: { now: () => current },
    sleep: async (ms) => {
      sleeps.push(ms)
      current += ms
    },
    sleeps,
  }
}

describe('pollUntil', () => {
  it('retries at the configured interval until the predicate succeeds', async () => {
    const clock = virtualClock()
    let attempts = 0

    const value = await pollUntil(
      async () => {
        attempts += 1
        return attempts === 3 ? 'ready' : null
      },
      { isReady: (result) => result === 'ready', label: 'otp capture', ...clock },
    )

    expect(value).toBe('ready')
    expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS])
  })

  it('includes the label and timeout when the predicate never succeeds', async () => {
    const clock = virtualClock()

    await expect(
      pollUntil(async () => null, {
        isReady: (result) => result !== null,
        label: 'otp capture channel=sms recipient=+15551234567',
        ...clock,
      }),
    ).rejects.toThrow('otp capture channel=sms recipient=+15551234567 timed out after 15000ms')
    expect(clock.sleeps).toHaveLength(POLL_TIMEOUT_MS / POLL_INTERVAL_MS)
  })

  it('returns immediately when the first attempt succeeds', async () => {
    const clock = virtualClock()

    await expect(
      pollUntil(async () => 'ready', {
        isReady: (result) => result === 'ready',
        label: 'otp capture',
        ...clock,
      }),
    ).resolves.toBe('ready')
    expect(clock.sleeps).toEqual([])
  })
})
