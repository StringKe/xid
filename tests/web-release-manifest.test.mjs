import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  coreCompatBuildEnvironment,
  coreCompatBuildPlan,
  workerModuleGraphSha256,
} from '../scripts/build-core-compat-artifact.mjs'
import {
  createWebReleaseManifest,
  validateWebReleaseManifest,
  WEB_RELEASE_PREFLIGHT_IDS,
  WEB_RELEASE_STAGE_IDS,
  WEB_ROUTE_CHANGE_IDS,
} from '../scripts/web-release-manifest.mjs'

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = join(TEST_DIRECTORY, '..')
const GIT_SHA = '1'.repeat(40)
const COMPAT_GIT_SHA = '2'.repeat(40)
const LOCKFILE_SHA256 = 'a'.repeat(64)
const COMPAT_LOCKFILE_SHA256 = 'b'.repeat(64)

function createTestManifest() {
  return createWebReleaseManifest({
    releaseId: 'xid-web-test',
    releaseGitSha: GIT_SHA,
    releaseLockfileSha256: LOCKFILE_SHA256,
    compatCoreGitSha: COMPAT_GIT_SHA,
    compatCoreLockfileSha256: COMPAT_LOCKFILE_SHA256,
  })
}

function successfulManifest(manifest) {
  const completed = structuredClone(manifest)
  completed.routeInventory.zoneId = 'f'.repeat(32)
  completed.productionBaseline = {
    frontendRoutes: [],
    workers: Object.fromEntries(
      ['xid', 'xid-console', 'xid-site'].map((workerName, index) => [
        workerName,
        {
          deploymentId: `deployment-${workerName}`,
          versions: [
            {
              percentage: 100,
              versionId: `10000000-0000-4000-8000-00000000000${index}`,
            },
          ],
        },
      ]),
    ),
  }
  completed.remoteCheckpoint = {
    deploymentId: '100',
    phase: 'SUCCESS',
    repositoryId: '200',
    workflowRunAttempt: '1',
    workflowRunId: '300',
  }
  for (const [index, stageId] of WEB_RELEASE_STAGE_IDS.entries()) {
    const artifact = completed.artifacts[stageId]
    artifact.artifactSha256 = String(index + 1).repeat(64)
    artifact.cloudflareVersionId = `00000000-0000-4000-8000-00000000000${index}`
    for (const operation of ['upload', 'preview', 'deploy', 'route']) {
      if (artifact[operation].result === 'UNKNOWN') artifact[operation].result = 'PASS'
    }
    artifact.rollback.result = 'SKIP'
  }
  for (const preflightId of WEB_RELEASE_PREFLIGHT_IDS) {
    completed.preflight[preflightId].result = 'PASS'
  }
  for (const changeId of WEB_ROUTE_CHANGE_IDS) {
    completed.routeChanges[changeId].result = changeId.endsWith('-activate') ? 'PASS' : 'SKIP'
  }
  return completed
}

describe('web release manifest', () => {
  it('keeps the checked-in example structurally valid and visibly incomplete', () => {
    const example = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, 'docs', 'web-release-manifest.example.json'), 'utf8'),
    )
    expect(validateWebReleaseManifest(example)).toEqual([])
    expect(validateWebReleaseManifest(example, { requireComplete: true })).not.toEqual([])
  })

  it('generates all four artifacts and the ordered route rollback boundary', () => {
    const manifest = createTestManifest()

    expect(Object.keys(manifest.artifacts)).toEqual(WEB_RELEASE_STAGE_IDS)
    expect(Object.keys(manifest.preflight)).toEqual(WEB_RELEASE_PREFLIGHT_IDS)
    expect(manifest.preflight['main-ci'].command).toContain('successful CI push run')
    expect(manifest.preflight['www-dns-proxied'].command).toContain('proxied=true')
    expect(manifest.preflight['worker-deployments-ready'].command).toContain(
      'active xid, xid-console, and xid-site',
    )
    expect(manifest.preflight['workers-builds-upload-only'].command).toContain(
      'reject a main trigger',
    )
    expect(manifest.preflight['worker-routes-contract'].command).toBe('pnpm run test:web-routes')
    expect(Object.keys(manifest.routeChanges)).toEqual(WEB_ROUTE_CHANGE_IDS)
    expect(manifest.productionBaseline).toBeNull()
    expect(manifest.remoteCheckpoint).toBeNull()
    expect(manifest.artifacts['compat-core'].gitSha).toBe(COMPAT_GIT_SHA)
    expect(manifest.artifacts.console.gitSha).toBe(GIT_SHA)
    expect(manifest.artifacts.console.deploy.command).toContain('versions deploy')
    expect(manifest.artifacts.console.deploy.result).toBe('UNKNOWN')
    expect(manifest.artifacts.site.deploy.command).toContain('versions deploy')
    expect(manifest.artifacts.site.deploy.result).toBe('UNKNOWN')
    expect(manifest.routeChanges['console-remove'].command).toContain(
      'Cloudflare Zone Workers Routes API',
    )
    expect(manifest.routeChanges['site-remove-public'].command).toContain('non-www route ids')
    expect(manifest.routeChanges['site-remove-www'].command).toContain('www route ids')
    expect(
      validateWebReleaseManifest(successfulManifest(manifest), {
        requireSuccessfulRelease: true,
      }),
    ).toEqual([])
  })

  it('rejects every result outside the successful release matrix', () => {
    const cases = [
      ['preflight.main-ci', 'PASS', (manifest) => (manifest.preflight['main-ci'].result = 'FAIL')],
      [
        'artifacts.console.upload',
        'PASS',
        (manifest) => (manifest.artifacts.console.upload.result = 'FAIL'),
      ],
      [
        'artifacts.site.preview',
        'PASS',
        (manifest) => (manifest.artifacts.site.preview.result = 'SKIP'),
      ],
      [
        'artifacts.tight-core.deploy',
        'PASS',
        (manifest) => (manifest.artifacts['tight-core'].deploy.result = 'FAIL'),
      ],
      [
        'artifacts.console.route',
        'PASS',
        (manifest) => (manifest.artifacts.console.route.result = 'SKIP'),
      ],
      [
        'routeChanges.site-activate',
        'PASS',
        (manifest) => (manifest.routeChanges['site-activate'].result = 'FAIL'),
      ],
      [
        'artifacts.compat-core.route',
        'SKIP',
        (manifest) => (manifest.artifacts['compat-core'].route.result = 'PASS'),
      ],
      [
        'artifacts.site.rollback',
        'SKIP',
        (manifest) => (manifest.artifacts.site.rollback.result = 'PASS'),
      ],
      [
        'routeChanges.console-remove',
        'SKIP',
        (manifest) => (manifest.routeChanges['console-remove'].result = 'PASS'),
      ],
    ]

    for (const [path, expectedResult, mutate] of cases) {
      const manifest = successfulManifest(createTestManifest())
      mutate(manifest)
      expect(validateWebReleaseManifest(manifest, { requireSuccessfulRelease: true })).toContain(
        `${path}.result must be ${expectedResult} for a successful release`,
      )
    }
  })

  it('allows SKIP only for structural release and rollback operations', () => {
    const manifest = successfulManifest(createTestManifest())

    expect(manifest.artifacts['compat-core'].route.result).toBe('SKIP')
    expect(manifest.artifacts['tight-core'].route.result).toBe('SKIP')
    expect(
      WEB_RELEASE_STAGE_IDS.map((stageId) => manifest.artifacts[stageId].rollback.result),
    ).toEqual(['SKIP', 'SKIP', 'SKIP', 'SKIP'])
    expect(
      WEB_ROUTE_CHANGE_IDS.filter((changeId) => changeId.includes('remove')).map(
        (changeId) => manifest.routeChanges[changeId].result,
      ),
    ).toEqual(['SKIP', 'SKIP', 'SKIP'])
    expect(validateWebReleaseManifest(manifest, { requireSuccessfulRelease: true })).toEqual([])
  })

  it('keeps failed rollback evidence valid without reporting a successful release', () => {
    const manifest = successfulManifest(createTestManifest())
    manifest.preflight['main-ci'].result = 'FAIL'

    expect(validateWebReleaseManifest(manifest, { requireComplete: true })).toEqual([])
    expect(validateWebReleaseManifest(manifest, { requireSuccessfulRelease: true })).toContain(
      'preflight.main-ci.result must be PASS for a successful release',
    )

    const directory = mkdtempSync(join(tmpdir(), 'xid-release-manifest-'))
    const manifestPath = join(directory, 'failed.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const script = join(REPOSITORY_ROOT, 'scripts', 'web-release-manifest.mjs')
    const successfulReleaseCheck = spawnSync(
      process.execPath,
      [script, 'validate', manifestPath, '--complete'],
      { encoding: 'utf8' },
    )
    const evidenceCheck = spawnSync(
      process.execPath,
      [script, 'validate', manifestPath, '--complete-evidence'],
      { encoding: 'utf8' },
    )

    expect(successfulReleaseCheck.status).not.toBe(0)
    expect(successfulReleaseCheck.stdout).not.toContain('PASS')
    expect(evidenceCheck.status).toBe(0)
    expect(evidenceCheck.stdout).not.toContain('PASS')
    expect(evidenceCheck.stdout).toContain('Recorded failure evidence')
  })

  it('rejects missing digests and secret-like fields', () => {
    const manifest = createTestManifest()
    manifest.artifacts.site.lockfileSha256 = 'bad'
    manifest.apiToken = 'not-a-real-token'

    const errors = validateWebReleaseManifest(manifest)
    expect(errors).toContain('artifacts.site.lockfileSha256 is invalid')
    expect(errors).toContain('$.apiToken uses a secret-like field name')
  })

  it('builds the compatibility artifact from a detached worktree without uploading', () => {
    const plan = coreCompatBuildPlan({
      gitSha: GIT_SHA,
      outputDirectory: join(REPOSITORY_ROOT, '.xid', 'releases'),
    })

    expect(plan.steps[0]).toContain('git worktree add --detach')
    expect(plan.steps).toContain('pnpm install --frozen-lockfile')
    expect(plan.steps).toContain('pnpm --filter @xid-kit/server build')
    expect(plan.steps.some((step) => step.includes('versions upload --dry-run'))).toBe(true)
    expect(plan.steps.some((step) => /versions upload(?!.*--dry-run)/u.test(step))).toBe(false)
    expect(plan.steps.some((step) => step.includes('wrangler deploy'))).toBe(false)
  })

  it('removes deployment credentials from the detached compatibility build environment', () => {
    const clean = coreCompatBuildEnvironment({
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      GITHUB_TOKEN: 'github-token',
      HOME: '/tmp/home',
      PATH: '/usr/bin',
    })

    expect(clean).toEqual({ HOME: '/tmp/home', PATH: '/usr/bin' })
  })

  it('digests the complete compatibility Worker module graph without generated metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xid-module-graph-'))
    mkdirSync(join(directory, 'assets'))
    writeFileSync(join(directory, 'index.js'), 'import "./assets/messages.js"')
    writeFileSync(join(directory, 'assets', 'messages.js'), 'export default {}')
    writeFileSync(join(directory, 'README.md'), 'generated at one time')
    const first = workerModuleGraphSha256(directory)

    writeFileSync(join(directory, 'README.md'), 'generated at another time')
    expect(workerModuleGraphSha256(directory)).toBe(first)
    writeFileSync(join(directory, 'assets', 'messages.js'), 'export default { changed: true }')
    expect(workerModuleGraphSha256(directory)).not.toBe(first)
  })
})
