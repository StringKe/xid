import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_KEYS,
  productionEvidenceReady,
  readProductionEvidenceFile,
} from './harness/production-evidence.mjs'

const context = {
  baseUrl: 'https://xid.dev',
  head: 'head_current',
  workers: {
    core: {
      buildId: 'build_core_current',
      checkRunId: 'check_core_current',
      deploymentId: 'deployment_core_current',
      workerVersionId: 'version_core_current',
      activePercentage: 100,
    },
    console: {
      buildId: 'build_console_current',
      checkRunId: 'check_console_current',
      deploymentId: 'deployment_console_current',
      workerVersionId: 'version_console_current',
      activePercentage: 100,
    },
    site: {
      buildId: 'build_site_current',
      checkRunId: 'check_site_current',
      deploymentId: 'deployment_site_current',
      workerVersionId: 'version_site_current',
      activePercentage: 100,
    },
  },
  accountId: '86e4d320a5d69fb54f9721fb219a4902',
  databaseId: '149e5997-e684-41d0-b483-afa6948479c3',
  migrationDigest: 'a'.repeat(64),
  remoteD1Migrations: {
    state: 'APPLIED',
    pending: [],
  },
  cloudflareSecurityRules: {
    manifestDigest: 'f'.repeat(64),
    deploymentState: 'RECONCILED',
  },
  wranglerConfigDigests: {
    core: 'b'.repeat(64),
    console: 'c'.repeat(64),
    site: 'd'.repeat(64),
  },
  checkConclusion: 'success',
  testConclusion: 'success',
  buildConclusion: 'success',
  smokeConclusion: 'success',
  securityConclusion: 'success',
}

function withWorkerContext(key, overrides) {
  return {
    ...context.workers,
    [key]: { ...context.workers[key], ...overrides },
  }
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 3,
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

function evidenceBoundTo(boundContext) {
  return {
    schemaVersion: 3,
    entries: {
      [EVIDENCE_KEYS.magicLinkFull]: {
        ...boundContext,
        key: EVIDENCE_KEYS.magicLinkFull,
        markers: ['browser_default_console', 'session_me_200'],
        preSmokeContext: boundContext,
        postSmokeContext: boundContext,
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
    ).resolves.toEqual({ schemaVersion: 3, entries: {} })
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
        evidence({ workers: withWorkerContext('site', { deploymentId: 'deployment_old' }) }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({ workers: withWorkerContext('console', { workerVersionId: 'version_old' }) }),
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
        evidence({
          wranglerConfigDigests: {
            ...context.wranglerConfigDigests,
            site: 'e'.repeat(64),
          },
        }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({ smokeConclusion: 'failure' }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        { ...evidence(), schemaVersion: 1 },
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
  })

  it('rejects changed Cloudflare controls and remote migration state', () => {
    const required = ['browser_default_console', 'session_me_200']
    expect(
      productionEvidenceReady(
        evidence({
          cloudflareSecurityRules: {
            ...context.cloudflareSecurityRules,
            manifestDigest: '0'.repeat(64),
          },
        }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({
          cloudflareSecurityRules: {
            ...context.cloudflareSecurityRules,
            deploymentState: 'EXTERNAL',
          },
        }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
    expect(
      productionEvidenceReady(
        evidence({
          remoteD1Migrations: {
            state: 'PENDING',
            pending: ['0008_control-plane-projects.sql'],
          },
        }),
        EVIDENCE_KEYS.magicLinkFull,
        context,
        required,
      ),
    ).toBe(false)
  })

  it('never accepts evidence while security rules are external or migrations are pending', () => {
    const required = ['browser_default_console', 'session_me_200']
    const externalContext = {
      ...context,
      cloudflareSecurityRules: {
        ...context.cloudflareSecurityRules,
        deploymentState: 'EXTERNAL',
      },
    }
    expect(
      productionEvidenceReady(
        evidenceBoundTo(externalContext),
        EVIDENCE_KEYS.magicLinkFull,
        externalContext,
        required,
      ),
    ).toBe(false)

    const pendingContext = {
      ...context,
      remoteD1Migrations: {
        state: 'PENDING',
        pending: ['0008_control-plane-projects.sql'],
      },
    }
    expect(
      productionEvidenceReady(
        evidenceBoundTo(pendingContext),
        EVIDENCE_KEYS.magicLinkFull,
        pendingContext,
        required,
      ),
    ).toBe(false)
  })
})
