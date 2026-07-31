import { describe, expect, it } from 'vitest'
import {
  complianceArtifactResponse,
  isComplianceChecksum,
  isComplianceStorageKey,
} from '../../compliance-artifact'
import { dpaAcceptanceAuditId } from '../../compliance'
import { isPersistedId } from '../../lib/persisted-id'
import { overallStatus } from '../../public-status'
import { resolveIncidentResolvedAt } from '../status-incidents'

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function checksum(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body)
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}`
}

function makeEnv(body: string, contentType = 'application/pdf'): Env {
  const bytes = new TextEncoder().encode(body)
  return {
    STORAGE: {
      get: async () => ({
        size: bytes.byteLength,
        httpMetadata: { contentType },
        arrayBuffer: async () => bytes.buffer,
      }),
    },
  } as unknown as Env
}

describe('platform operations public boundaries', () => {
  it('derives the most severe active incident status', () => {
    expect(overallStatus([])).toBe('operational')
    expect(overallStatus(['minor'])).toBe('degraded')
    expect(overallStatus(['minor', 'major'])).toBe('partial_outage')
    expect(overallStatus(['major', 'critical'])).toBe('major_outage')
  })

  it('keeps resolved_at consistent with the incident state', () => {
    const now = new Date('2026-07-28T12:00:00.000Z')
    const resolvedAt = new Date('2026-07-28T11:00:00.000Z')

    expect(
      resolveIncidentResolvedAt(
        { status: 'investigating', resolvedAt: null },
        'resolved',
        undefined,
        now,
      ),
    ).toEqual(now)
    expect(
      resolveIncidentResolvedAt({ status: 'resolved', resolvedAt }, 'resolved', undefined, now),
    ).toEqual(resolvedAt)
    expect(
      resolveIncidentResolvedAt({ status: 'resolved', resolvedAt }, 'monitoring', undefined, now),
    ).toBeNull()
    expect(() =>
      resolveIncidentResolvedAt({ status: 'resolved', resolvedAt }, 'resolved', null, now),
    ).toThrow()
    expect(() =>
      resolveIncidentResolvedAt(
        { status: 'investigating', resolvedAt: null },
        'monitoring',
        now.toISOString(),
        now,
      ),
    ).toThrow()
  })

  it('derives one stable audit id for concurrent DPA acceptance retries', async () => {
    const first = await dpaAcceptanceAuditId('org_1', 'dpa', '2026-07')
    const retry = await dpaAcceptanceAuditId('org_1', 'dpa', '2026-07')
    const otherTenant = await dpaAcceptanceAuditId('org_2', 'dpa', '2026-07')

    expect(first).toBe(retry)
    expect(first).not.toBe(otherTenant)
    expect(isPersistedId('platformAudit', first)).toBe(true)
  })

  it('accepts only immutable compliance object keys and SHA-256 checksums', () => {
    expect(isComplianceStorageKey('compliance/dpa/2026-07.pdf')).toBe(true)
    expect(isComplianceStorageKey('compliance/')).toBe(false)
    expect(isComplianceStorageKey('compliance//dpa.pdf')).toBe(false)
    expect(isComplianceStorageKey('compliance/dpa.pdf/')).toBe(false)
    expect(isComplianceStorageKey('compliance/dpa\\private.pdf')).toBe(false)
    expect(isComplianceStorageKey('compliance/dpa\u0000.pdf')).toBe(false)
    expect(isComplianceStorageKey('logos/dpa.pdf')).toBe(false)
    expect(isComplianceStorageKey('compliance/../private-key')).toBe(false)
    expect(isComplianceChecksum(`sha256:${'a'.repeat(64)}`)).toBe(true)
    expect(isComplianceChecksum(`sha256:${'A'.repeat(64)}`)).toBe(false)
  })

  it('verifies R2 bytes before returning a private attachment', async () => {
    const body = 'signed-dpa'
    const response = await complianceArtifactResponse(makeEnv(body), {
      title: 'DPA 2026',
      storageKey: 'compliance/dpa/2026-07.pdf',
      checksum: await checksum(body),
    })

    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="DPA_2026.pdf"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(body)
  })

  it('fails closed when the stored artifact checksum does not match', async () => {
    await expect(
      complianceArtifactResponse(makeEnv('tampered'), {
        title: 'DPA',
        storageKey: 'compliance/dpa/2026-07.pdf',
        checksum: await checksum('expected'),
      }),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable', httpStatus: 503 })
  })
})
