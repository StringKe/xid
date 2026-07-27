import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workerModuleGraphSha256 } from '../scripts/build-core-compat-artifact.mjs'
import {
  ALLOWED_COMPAT_CORE_SHA,
  activeDeploymentSnapshot,
  assertCleanFrontendRouteBaseline,
  assertSafeCoreBuildTriggers,
  canRemoveFrontendRoutes,
  checkpointPhaseFromStatus,
  createCompatUploadConfig,
  deploymentSnapshotsEqual,
  deploymentVersionSplitsEqual,
  hasActiveDeployment,
  isUploadOnlyCoreBuildTrigger,
  markOperationStarted,
  parseWranglerVersionUploadOutput,
  recoveryActionForCheckpointPhase,
  releaseCommandEnvironment,
  selectRollbackRoutes,
  triggerAffectsMain,
  validateHttpSnapshot,
  validateReleaseCheckpointPayload,
  verifyModuleGraphIdentity,
  verifyTaggedVersion,
} from '../scripts/run-web-release.mjs'

const VERSION_ID = '12345678-1234-4123-8123-123456789abc'

describe('web release runner', () => {
  it('parses the Wrangler NDJSON contract without scraping console output', () => {
    const output = JSON.stringify({
      type: 'version-upload',
      version: 1,
      worker_name: 'xid-console',
      version_id: VERSION_ID,
      preview_url: 'https://12345678-xid-console.example.workers.dev',
      preview_alias_url: 'https://release-xid-console.example.workers.dev',
    })

    expect(parseWranglerVersionUploadOutput(output, 'xid-console').version_id).toBe(VERSION_ID)
  })

  it('rejects missing preview URLs', () => {
    const output = JSON.stringify({
      type: 'version-upload',
      version: 1,
      worker_name: 'xid-site',
      version_id: VERSION_ID,
      preview_url: null,
      preview_alias_url: null,
    })

    expect(() => parseWranglerVersionUploadOutput(output, 'xid-site')).toThrow('preview_url')
    expect(
      parseWranglerVersionUploadOutput(output, 'xid-site', { requirePreview: false }).version_id,
    ).toBe(VERSION_ID)
  })

  it('verifies the immutable version tag against versions list JSON', () => {
    const versions = [
      {
        id: VERSION_ID,
        annotations: { 'workers/tag': 'site-release-1' },
      },
    ]

    expect(verifyTaggedVersion(versions, 'site-release-1', VERSION_ID).id).toBe(VERSION_ID)
  })

  it('accepts only upload-only Core main triggers', () => {
    const trigger = {
      root_directory: 'apps/server',
      branch_includes: ['main'],
      branch_excludes: [],
      deploy_command: 'pnpm exec wrangler versions upload',
    }

    expect(triggerAffectsMain(trigger)).toBe(true)
    expect(isUploadOnlyCoreBuildTrigger(trigger)).toBe(true)
    expect(
      isUploadOnlyCoreBuildTrigger({
        ...trigger,
        deploy_command: 'pnpm exec wrangler deploy',
      }),
    ).toBe(false)
    expect(
      isUploadOnlyCoreBuildTrigger({
        ...trigger,
        deploy_command:
          'pnpm exec wrangler d1 migrations apply DB --remote && pnpm exec wrangler versions upload',
      }),
    ).toBe(false)
    expect(() => assertSafeCoreBuildTriggers([])).toThrow('no Builds trigger')
    expect(() => assertSafeCoreBuildTriggers([trigger])).not.toThrow()
    expect(() =>
      assertSafeCoreBuildTriggers([{ ...trigger, deploy_command: 'pnpm exec wrangler deploy' }]),
    ).toThrow('upload-only')
  })

  it('preserves frontend routes until compatibility Core restore passes', () => {
    expect(canRemoveFrontendRoutes('PASS')).toBe(true)
    expect(canRemoveFrontendRoutes('FAIL')).toBe(false)
    expect(canRemoveFrontendRoutes('UNKNOWN')).toBe(false)
  })

  it('records FAIL before a remote operation starts', () => {
    const record = { command: 'remote mutation', result: 'UNKNOWN' }

    expect(markOperationStarted(record)).toEqual({
      command: 'remote mutation',
      result: 'FAIL',
    })
  })

  it('derives rollback only from a durable production intent', () => {
    expect(recoveryActionForCheckpointPhase('PREPARED')).toBe('SKIP')
    expect(recoveryActionForCheckpointPhase('COMPAT_INTENT')).toBe('ROLLBACK')
    expect(recoveryActionForCheckpointPhase('COMPAT_VERIFIED')).toBe('ROLLBACK')
    expect(recoveryActionForCheckpointPhase('SITE_ROUTES_INTENT')).toBe('ROLLBACK')
    expect(recoveryActionForCheckpointPhase('TIGHT_INTENT')).toBe('ROLLBACK')
    expect(recoveryActionForCheckpointPhase('SUCCESS')).toBe('VERIFY_RELEASE')
    expect(recoveryActionForCheckpointPhase('ROLLED_BACK')).toBe('VERIFY_BASELINE')
    expect(() => recoveryActionForCheckpointPhase('UNKNOWN')).toThrow('unknown checkpoint phase')
  })

  it('requires every checkpoint phase to use its exact GitHub deployment state', () => {
    expect(checkpointPhaseFromStatus(null)).toBe('PREPARED')
    expect(checkpointPhaseFromStatus({ description: 'COMPAT_INTENT', state: 'in_progress' })).toBe(
      'COMPAT_INTENT',
    )
    expect(checkpointPhaseFromStatus({ description: 'SUCCESS', state: 'success' })).toBe('SUCCESS')
    expect(checkpointPhaseFromStatus({ description: 'ROLLED_BACK', state: 'inactive' })).toBe(
      'ROLLED_BACK',
    )
    expect(() => checkpointPhaseFromStatus({ description: 'SUCCESS', state: 'failure' })).toThrow(
      'expected success',
    )
  })

  it('keeps production credentials out of build commands', () => {
    const environment = {
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      GITHUB_TOKEN: 'github-token',
      HOME: '/tmp/home',
      PATH: '/usr/bin',
    }

    expect(releaseCommandEnvironment(environment)).toEqual({
      HOME: '/tmp/home',
      PATH: '/usr/bin',
    })
    expect(releaseCommandEnvironment(environment, { cloudflare: true })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      HOME: '/tmp/home',
      PATH: '/usr/bin',
    })
  })

  it('requires an active percentage in the latest Worker deployment', () => {
    expect(
      hasActiveDeployment({
        deployments: [
          {
            created_on: '2026-07-27T10:00:00Z',
            id: 'deployment',
            versions: [{ percentage: 100, version_id: VERSION_ID }],
          },
        ],
      }),
    ).toBe(true)
    expect(hasActiveDeployment({ deployments: [] })).toBe(false)
    expect(
      hasActiveDeployment({
        deployments: [{ created_on: '2026-07-27T10:00:00Z', versions: [] }],
      }),
    ).toBe(false)
    expect(
      activeDeploymentSnapshot({
        deployments: [
          {
            created_on: '2026-07-27T10:00:00Z',
            id: 'deployment',
            versions: [{ percentage: 100, version_id: VERSION_ID }],
          },
        ],
      }),
    ).toEqual({
      deploymentId: 'deployment',
      versions: [{ percentage: 100, versionId: VERSION_ID }],
    })
    expect(
      deploymentSnapshotsEqual(
        {
          deploymentId: 'deployment',
          versions: [
            { percentage: 60, versionId: VERSION_ID },
            {
              percentage: 40,
              versionId: '22345678-1234-4123-8123-123456789abc',
            },
          ],
        },
        {
          deploymentId: 'deployment',
          versions: [
            {
              percentage: 40,
              versionId: '22345678-1234-4123-8123-123456789abc',
            },
            { percentage: 60, versionId: VERSION_ID },
          ],
        },
      ),
    ).toBe(true)
    expect(
      deploymentVersionSplitsEqual(
        {
          deploymentId: 'before',
          versions: [{ percentage: 100, versionId: VERSION_ID }],
        },
        {
          deploymentId: 'after',
          versions: [{ percentage: 100, versionId: VERSION_ID }],
        },
      ),
    ).toBe(true)
    expect(
      deploymentSnapshotsEqual(
        {
          deploymentId: 'before',
          versions: [{ percentage: 100, versionId: VERSION_ID }],
        },
        {
          deploymentId: 'after',
          versions: [{ percentage: 100, versionId: VERSION_ID }],
        },
      ),
    ).toBe(false)
  })

  it('validates exact media types, bodies, and one-hop locations', () => {
    const snapshot = {
      body: 'Published pages: 328',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        location: 'https://xid.dev/getting-started?release-smoke=1',
      },
      status: 308,
      url: 'https://www.xid.dev/getting-started?release-smoke=1',
    }
    const options = {
      bodyIncludes: 'Published pages: 328',
      exactContentType: 'text/plain; charset=utf-8',
      exactLocation: 'https://xid.dev/getting-started?release-smoke=1',
      statuses: [308],
    }

    expect(() => validateHttpSnapshot(snapshot, options)).not.toThrow()
    expect(() =>
      validateHttpSnapshot(
        {
          ...snapshot,
          headers: { ...snapshot.headers, 'content-type': 'text/plain' },
        },
        options,
      ),
    ).toThrow('expected exactly')
    expect(() =>
      validateHttpSnapshot({ ...snapshot, body: 'Published pages: 327' }, options),
    ).toThrow('body does not include')
    expect(() =>
      validateHttpSnapshot(snapshot, { ...options, exactBody: 'Published pages: 327' }),
    ).toThrow('does not exactly match')
  })

  it('requires the one-time migration to start without frontend Worker routes', () => {
    expect(assertCleanFrontendRouteBaseline([])).toEqual([])
    expect(() =>
      assertCleanFrontendRouteBaseline([{ id: 'site', pattern: 'xid.dev/', script: 'xid-site' }]),
    ).toThrow('frontend Worker routes already exist')
  })

  it('validates the durable GitHub deployment checkpoint identity and Core baseline', () => {
    const payload = {
      schemaVersion: 1,
      workflowRunId: '300',
      workflowRunAttempt: '1',
      repositoryId: '200',
      releaseId: 'xid-web-test',
      releaseGitSha: '1'.repeat(40),
      releaseLockfileSha256: 'a'.repeat(64),
      compatCoreGitSha: ALLOWED_COMPAT_CORE_SHA,
      compatCoreLockfileSha256: 'b'.repeat(64),
      compatCoreVersionId: VERSION_ID,
      productionBaseline: {
        frontendRoutes: [],
        workers: Object.fromEntries(
          ['xid', 'xid-console', 'xid-site'].map((workerName) => [
            workerName,
            {
              deploymentId: `deployment-${workerName}`,
              versions: [{ percentage: 100, versionId: VERSION_ID }],
            },
          ]),
        ),
      },
      zoneId: 'f'.repeat(32),
      expectedPatterns: {
        console: ['xid.dev/console'],
        site: ['xid.dev/'],
      },
    }

    expect(
      validateReleaseCheckpointPayload(payload, {
        releaseGitSha: '1'.repeat(40),
        repositoryId: '200',
        workflowRunAttempt: '1',
        workflowRunId: '300',
      }),
    ).toBe(payload)
    expect(() =>
      validateReleaseCheckpointPayload(
        {
          ...payload,
          productionBaseline: {
            ...payload.productionBaseline,
            workers: {
              ...payload.productionBaseline.workers,
              xid: {
                deploymentId: 'deployment-xid',
                versions: [{ percentage: 50, versionId: VERSION_ID }],
              },
            },
          },
        },
        {
          releaseGitSha: '1'.repeat(40),
          repositoryId: '200',
          workflowRunAttempt: '1',
          workflowRunId: '300',
        },
      ),
    ).toThrow('percentages total')
  })

  it('selects only recorded route patterns in the fixed rollback order', () => {
    const routes = [
      { id: 'console', pattern: 'xid.dev/console', script: 'xid-console' },
      { id: 'site', pattern: 'xid.dev/', script: 'xid-site' },
      { id: 'www', pattern: 'www.xid.dev/*', script: 'xid-site' },
    ]

    expect(
      selectRollbackRoutes(routes, {
        expectedPatterns: ['xid.dev/console'],
        mode: 'all',
        workerName: 'xid-console',
      }).map((route) => route.id),
    ).toEqual(['console'])
    expect(
      selectRollbackRoutes(routes, {
        expectedPatterns: ['xid.dev/', 'www.xid.dev/*'],
        mode: 'non-www',
        workerName: 'xid-site',
      }).map((route) => route.id),
    ).toEqual(['site'])
    expect(
      selectRollbackRoutes(routes, {
        expectedPatterns: ['xid.dev/', 'www.xid.dev/*'],
        mode: 'www',
        workerName: 'xid-site',
      }).map((route) => route.id),
    ).toEqual(['www'])
    expect(() =>
      selectRollbackRoutes(
        [{ id: 'unexpected', pattern: 'xid.dev/unreviewed', script: 'xid-site' }],
        {
          expectedPatterns: ['xid.dev/'],
          mode: 'non-www',
          workerName: 'xid-site',
        },
      ),
    ).toThrow('unexpected route patterns')
  })

  it('pins the only compatibility Core commit accepted by the runner', () => {
    expect(ALLOWED_COMPAT_CORE_SHA).toBe('995f65c6aae0bdc77e8a0fdbf0222f51143ce2d2')
  })

  it('rejects a changed compatibility Worker additional module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xid-uploaded-module-graph-'))
    mkdirSync(join(directory, 'assets'))
    writeFileSync(join(directory, 'index.js'), 'import "./assets/messages.js"')
    writeFileSync(join(directory, 'assets', 'messages.js'), 'export default {}')
    const expected = workerModuleGraphSha256(directory)

    expect(verifyModuleGraphIdentity(expected, directory)).toBe(expected)
    writeFileSync(join(directory, 'assets', 'messages.js'), 'export default { changed: true }')
    expect(() => verifyModuleGraphIdentity(expected, directory)).toThrow(
      'uploaded module graph SHA-256',
    )
  })

  it('configures Wrangler to upload every prebundled compatibility ES module', () => {
    const config = createCompatUploadConfig({
      d1_databases: [
        {
          binding: 'DB',
          database_id: 'database',
          migrations_dir: '../../packages/db/drizzle',
        },
      ],
      main: 'worker/index.ts',
      name: 'xid',
    })

    expect(config).toMatchObject({
      base_dir: './worker-bundle',
      find_additional_modules: true,
      main: './worker-bundle/index.js',
      no_bundle: true,
      rules: [{ globs: ['**/*.js', '**/*.mjs'], type: 'ESModule' }],
    })
    expect(config.d1_databases[0]).not.toHaveProperty('migrations_dir')
  })

  it('keeps the complete prebundled ES module graph in Wrangler dry-run output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xid-compat-wrangler-'))
    const bundleDirectory = join(directory, 'worker-bundle')
    const moduleDirectory = join(bundleDirectory, 'assets')
    const staticDirectory = join(directory, 'static-assets')
    const outputDirectory = join(directory, 'out')
    mkdirSync(moduleDirectory, { recursive: true })
    mkdirSync(staticDirectory)
    writeFileSync(
      join(bundleDirectory, 'index.js'),
      'import "./assets/messages.js"\nexport default { fetch() { return new Response("ok") } }\n',
    )
    writeFileSync(join(moduleDirectory, 'messages.js'), 'export default { locale: "en" }\n')
    writeFileSync(join(staticDirectory, 'index.html'), '<div id="root"></div>\n')
    const config = createCompatUploadConfig({
      assets: { binding: 'ASSETS' },
      compatibility_date: '2025-04-08',
      main: 'worker/index.ts',
      name: 'xid-compat-dry-run',
    })
    const configPath = join(directory, 'wrangler.json')
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'wrangler',
        'versions',
        'upload',
        '--dry-run',
        '--config',
        configPath,
        '--outdir',
        outputDirectory,
      ],
      { cwd: process.cwd(), encoding: 'utf8', shell: false },
    )

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(workerModuleGraphSha256(outputDirectory)).toBe(workerModuleGraphSha256(bundleDirectory))
  })
})
