import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEdgeProbePayload, measureVerifyMicros } from './edge-probe'

describe('edge-probe', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('measures ES256 verify latency in microseconds', async () => {
    const verifyUs = await measureVerifyMicros()
    expect(verifyUs).toBeGreaterThan(0)
    expect(verifyUs).toBeLessThan(50_000)
  })

  it('does not export the generated probe public key', async () => {
    vi.resetModules()
    const exportSpy = vi.spyOn(crypto.subtle, 'exportKey').mockRejectedValue(new Error('blocked'))
    const freshProbe = await import('./edge-probe')

    await expect(freshProbe.measureVerifyMicros()).resolves.toBeGreaterThan(0)
    expect(exportSpy).not.toHaveBeenCalled()
  })

  it('keeps verifying after the first probe token would have expired', async () => {
    vi.resetModules()
    const freshProbe = await import('./edge-probe')
    const now = Date.now()
    vi.setSystemTime(now)
    await expect(freshProbe.measureVerifyMicros()).resolves.toBeGreaterThan(0)

    vi.setSystemTime(now + 121_000)
    await expect(freshProbe.measureVerifyMicros()).resolves.toBeGreaterThan(0)
  })

  it('buildEdgeProbePayload returns probe fields without cf metadata', async () => {
    const payload = await buildEdgeProbePayload(undefined)
    expect(payload.colo).toBeNull()
    expect(payload.tlsVersion).toBeNull()
    expect(payload.signingAlg).toBe('ES256')
    expect(payload.accessTokenTtlSec).toBe(60)
    expect(payload.jwksRoundTrips).toBe(0)
    expect(payload.verifyUs).toBeGreaterThan(0)
  })
})
