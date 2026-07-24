import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_KEYS,
  productionEvidenceReady,
  readProductionEvidenceFile,
} from './harness/production-evidence.mjs'

const context = {
  baseUrl: 'https://xid.dev',
  head: 'head_current',
  buildId: 'build_current',
  checkRunId: 'check_current',
  deploymentId: 'deployment_current',
  workerVersionId: 'version_current',
  activePercentage: 100,
  accountId: '86e4d320a5d69fb54f9721fb219a4902',
  databaseId: '149e5997-e684-41d0-b483-afa6948479c3',
  migrationDigest: 'a'.repeat(64),
  wranglerConfigDigest: 'b'.repeat(64),
  qualityConclusion: 'success',
  securityConclusion: 'success',
}

function evidence(overrides = {}) {
  return {
    entries: {
      [EVIDENCE_KEYS.magicLinkFull]: {
        ...context,
        key: EVIDENCE_KEYS.magicLinkFull,
        markers: ['browser_default_console', 'session_me_200'],
        preSmokeContext: context,
        postSmokeContext: context,
        ...overrides,
      },
    },
  }
}

describe('production evidence readiness', () => {
  it('accepts only a missing evidence file and surfaces corrupt evidence', async () => {
    await expect(
      readProductionEvidenceFile({
        path: '/tmp/xid-missing-evidence.json',
        readFileFn: async () => {
          const error = new Error('missing')
          error.code = 'ENOENT'
          throw error
        },
      }),
    ).resolves.toEqual({ schemaVersion: 1, entries: {} })
    await expect(
      readProductionEvidenceFile({
        path: '/tmp/xid-corrupt-evidence.json',
        readFileFn: async () => '{',
      }),
    ).rejects.toThrow('production evidence file is invalid: /tmp/xid-corrupt-evidence.json')
  })

  it('accepts only matching current production evidence', () => {
    expect(
      productionEvidenceReady(evidence(), EVIDENCE_KEYS.magicLinkFull, context, [
        'browser_default_console',
        'session_me_200',
      ]),
    ).toBe(true)
  })

  it('rejects stale head, stale deployment, stale worker version and missing markers', () => {
    const required = ['browser_default_console', 'session_me_200']
    expect(
      productionEvidenceReady(
        evidence({ head: 'head_old' }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({ deploymentId: 'deployment_old' }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({ workerVersionId: 'version_old' }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({ markers: ['browser_default_console'] }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
  })

  it('rejects fabricated evidence without matching pre and post smoke snapshots', () => {
    const required = ['browser_default_console', 'session_me_200']
    expect(
      productionEvidenceReady(
        evidence({ preSmokeContext: undefined, postSmokeContext: undefined }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({
          postSmokeContext: { ...context, migrationDigest: 'b'.repeat(64) },
        }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
  })

  it('rejects evidence with changed config or required CI conclusion', () => {
    const required = ['browser_default_console', 'session_me_200']
    expect(
      productionEvidenceReady(
        evidence({ wranglerConfigDigest: 'c'.repeat(64) }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({ securityConclusion: 'failure' }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
  })
})
