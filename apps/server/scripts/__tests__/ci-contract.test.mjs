import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  assertActiveDeployment,
  assertRequiredCiConclusions,
  assertSuccessfulWorkersBuilds,
  PRODUCTION_WORKER_KEYS,
  readCloudflareSecurityRulesState,
  readConfiguredDeploymentTargets,
  REQUIRED_CI_CHECKS,
  verifiedRemoteD1MigrationArgs,
} from '../production-target.mjs'
import { parseJsonc } from '../../../../scripts/verify-worker-routes.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..', '..', '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml')
const packageJsonPath = join(repoRoot, 'package.json')
const secretScannerPath = join(scriptDir, '..', 'check-repository-secrets.mjs')
const productionWranglerPaths = [
  'apps/server/wrangler.jsonc',
  'apps/console/wrangler.jsonc',
  'apps/site/wrangler.jsonc',
]
const readmePaths = [
  'README.md',
  'README.zh-Hans.md',
  'README.ja.md',
  'README.ko.md',
  'README.fr.md',
  'README.de.md',
  'README.es.md',
  'README.pt-BR.md',
]

function isImmutableActionReference(value) {
  return /^[^@\s]+@[a-f0-9]{40}$/u.test(value)
}

// 取单个 job 的完整 YAML 块。job 键固定 2 空格缩进,块在下一个 2 空格顶层键(或注释)前结束。
function jobBlock(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  if (start === -1) return undefined
  const body = workflow.slice(start + 1)
  const next = body.slice(1).search(/\n {2}[A-Za-z#]/u)
  return next === -1 ? body : body.slice(0, next + 1)
}

describe('CI release contract', () => {
  it('keeps the security gates wired without a production deploy credential', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

    expect(workflow).toContain('pnpm run security:dependencies')
    expect(workflow).toContain('pnpm run security:secret-scan')
    expect(workflow).toContain('- run: pnpm smoke:l2-l3')
    expect(workflow).not.toContain('wrangler deploy')
    expect(packageJson.scripts['smoke:l2-l3']).toBe('node apps/server/scripts/run-l2-l3-smoke.mjs')
    expect(packageJson.scripts['security:dependencies']).toBe(
      'pnpm audit --prod --audit-level high',
    )
    expect(packageJson.scripts['security:secret-scan']).toBe(
      'node apps/server/scripts/check-repository-secrets.mjs',
    )
  })

  it('keeps production on main-only Workers Builds without public Preview URLs', () => {
    for (const relativePath of productionWranglerPaths) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8')
      expect(parseJsonc(source, relativePath).preview_urls, relativePath).toBe(false)
    }

    for (const relativePath of readmePaths) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8')
      expect(source, relativePath).toContain('Cloudflare Workers Builds')
      expect(source, relativePath).not.toContain('pnpm exec wrangler deploy --config apps/')
      expect(source, relativePath).not.toContain('npx wrangler d1 migrations apply DB --remote')
    }
  })

  it('keeps the non-deterministic dependency audit off the blocking security job', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    const auditJob = jobBlock(workflow, 'dependency-audit')
    const securityJob = jobBlock(workflow, 'security')

    expect(auditJob).toBeDefined()
    expect(securityJob).toBeDefined()
    expect(auditJob).toContain('pnpm run security:dependencies')
    // 审计查实时 advisory DB,同一 commit 结论会漂移,不能拖住 secret scan 这个确定性门禁。
    expect(securityJob).not.toContain('pnpm run security:dependencies')
    expect(securityJob).toContain('pnpm run security:secret-scan')
    // continue-on-error 会把红 job 显示成绿色,等于对结论撒谎;要的是"红但不 required"。
    expect(auditJob).not.toContain('continue-on-error')
  })

  it('runs only on ubuntu runners and ships no native SDK jobs', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    // macOS 计费是 Linux 的 10 倍、Windows 是 2 倍。13 个原生 SDK job 曾经把整条流水线的
    // 单次消耗推到约 400 分钟当量,直接耗尽配额并让每个 job 以 "The job was not started because
    // recent account payments have failed" 失败 -- 那时红的不是代码,是账单。
    // 原生 SDK 不发布到任何 registry,且 sdk/ 对 packages/* 的引用数为 0,CI 跑它们买不到
    // 与核心正确性相关的信息。本地入口:XID_NATIVE_SDK_PLATFORM=<platform> pnpm run native:verify
    const runners = [...workflow.matchAll(/^\s*runs-on: (.+)$/gmu)].map((m) => m[1])
    expect(runners.length).toBeGreaterThan(0)
    for (const runner of runners) {
      expect(runner, 'only ubuntu runners are affordable here').toBe('ubuntu-latest')
    }

    for (const name of ['native-linux', 'native-flutter', 'native-ios', 'native-dotnet']) {
      expect(jobBlock(workflow, name), `${name} must stay out of CI`).toBeUndefined()
    }
    // paths-filter 的唯一用途是给原生 SDK job 做增量筛选,它们没了,filter 也不该留着。
    expect(workflow).not.toContain('dorny/paths-filter')
  })

  it('keeps the long and non-deterministic jobs off the pull-request path', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    // smoke 起 wrangler dev + Chrome,30 分钟且有多种 flaky 签名;audit 查实时 advisory DB,
    // 结论与被测 commit 无因果关系。两者都不该决定一个 PR 能不能合并。
    for (const name of ['smoke', 'dependency-audit']) {
      const job = jobBlock(workflow, name)
      expect(job, `missing ${name} job`).toBeDefined()
      expect(job, `${name} must not run on pull requests`).toContain(
        "if: github.event_name != 'pull_request'",
      )
    }

    // 反过来,核心三件套必须无条件跑在每个 PR 上 -- 它们是"核心正确"的全部证明。
    for (const name of ['check', 'test', 'build']) {
      const job = jobBlock(workflow, name)
      expect(job, `missing ${name} job`).toBeDefined()
      expect(job, `${name} must stay unconditional`).not.toContain('if:')
    }
  })

  it('splits the long quality job so a smoke failure does not hide check/test/build verdicts', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain('- run: pnpm check')
    expect(workflow).toContain('- run: pnpm test')
    expect(workflow).toContain('- run: pnpm build')
    expect(workflow).toContain('- run: pnpm smoke:l2-l3')
    expect(workflow).not.toContain('quality:')
  })

  it('binds production evidence to every deterministic main CI verdict', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const head = 'a'.repeat(40)
    const output = JSON.stringify({
      check_runs: REQUIRED_CI_CHECKS.map((name) => ({
        name,
        head_sha: head,
        status: 'completed',
        conclusion: 'success',
      })),
    })

    for (const name of REQUIRED_CI_CHECKS) {
      expect(
        jobBlock(workflow, name),
        `missing required production evidence job ${name}`,
      ).toBeDefined()
    }
    expect(assertRequiredCiConclusions(output, head)).toEqual({
      check: 'success',
      test: 'success',
      build: 'success',
      smoke: 'success',
      security: 'success',
    })

    const missingSmoke = JSON.stringify({
      check_runs: JSON.parse(output).check_runs.filter((check) => check.name !== 'smoke'),
    })
    expect(() => assertRequiredCiConclusions(missingSmoke, head)).toThrow(
      `required CI check smoke must appear exactly once for ${head}`,
    )
  })

  it('binds production evidence to Core, Console, and Site Workers Builds', () => {
    const head = 'b'.repeat(40)
    const targets = {
      core: { workerName: 'xid' },
      console: { workerName: 'xid-console' },
      site: { workerName: 'xid-site' },
    }
    const requiredChecks = REQUIRED_CI_CHECKS.map((name) => ({
      name,
      head_sha: head,
      status: 'completed',
      conclusion: 'success',
    }))
    const workerChecks = PRODUCTION_WORKER_KEYS.map((key, index) => ({
      name: `Workers Builds: ${targets[key].workerName}`,
      head_sha: head,
      status: 'completed',
      conclusion: 'success',
      id: index + 1,
      external_id: `build-${key}`,
      output: { summary: `Version ID: 00000000-0000-4000-8000-00000000000${index}` },
    }))
    const output = JSON.stringify({ check_runs: [...requiredChecks, ...workerChecks] })

    expect(assertSuccessfulWorkersBuilds(output, head, targets).workers).toEqual({
      core: {
        buildId: 'build-core',
        checkRunId: 1,
        workerVersionId: '00000000-0000-4000-8000-000000000000',
      },
      console: {
        buildId: 'build-console',
        checkRunId: 2,
        workerVersionId: '00000000-0000-4000-8000-000000000001',
      },
      site: {
        buildId: 'build-site',
        checkRunId: 3,
        workerVersionId: '00000000-0000-4000-8000-000000000002',
      },
    })

    expect(() =>
      assertSuccessfulWorkersBuilds(
        JSON.stringify({ check_runs: [...requiredChecks, ...workerChecks.slice(0, 2)] }),
        head,
        targets,
      ),
    ).toThrow(`Workers Builds: xid-site must appear exactly once for ${head}`)
  })

  it('locks all three production Worker targets to the same account', () => {
    const targets = readConfiguredDeploymentTargets()

    expect(Object.keys(targets)).toEqual(PRODUCTION_WORKER_KEYS)
    expect(targets.core.workerName).toBe('xid')
    expect(targets.console.workerName).toBe('xid-console')
    expect(targets.site.workerName).toBe('xid-site')
    expect(new Set(PRODUCTION_WORKER_KEYS.map((key) => targets[key].accountId))).toHaveLength(1)
    expect(targets.core.databaseId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(targets.console.databaseId).toBeNull()
    expect(targets.site.databaseId).toBeNull()
  })

  it('binds the security manifest and remote migration command to verified production inputs', () => {
    const controls = readCloudflareSecurityRulesState()
    const target = readConfiguredDeploymentTargets().core

    expect(controls.manifestDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(['EXTERNAL', 'RECONCILED']).toContain(controls.deploymentState)
    expect(verifiedRemoteD1MigrationArgs(target.configPath)).toEqual([
      '--filter',
      '@xid-kit/server',
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'list',
      'DB',
      '--remote',
      '--config',
      target.configPath,
    ])
  })

  it('requires one exact 100 percent deployment for each Workers Builds version', () => {
    const expectedVersionId = '00000000-0000-4000-8000-000000000001'
    const active = {
      id: 'deployment-current',
      versions: [{ version_id: expectedVersionId, percentage: 100 }],
    }

    expect(assertActiveDeployment(JSON.stringify(active), expectedVersionId, 'xid-site')).toEqual({
      deploymentId: 'deployment-current',
      workerVersionId: expectedVersionId,
      activePercentage: 100,
    })
    expect(() =>
      assertActiveDeployment(
        JSON.stringify({
          ...active,
          versions: [
            { version_id: expectedVersionId, percentage: 100 },
            { version_id: 'other-version', percentage: 100 },
          ],
        }),
        expectedVersionId,
        'xid-site',
      ),
    ).toThrow('xid-site must have exactly one 100 percent active Worker version')
    expect(() =>
      assertActiveDeployment(
        JSON.stringify({
          ...active,
          versions: [{ version_id: 'stale-version', percentage: 100 }],
        }),
        expectedVersionId,
        'xid-site',
      ),
    ).toThrow(
      `xid-site active Worker version stale-version does not match Workers Builds version ${expectedVersionId}`,
    )
  })

  it('passes the verified Linux Chrome path to every smoke command', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const smokeJob = jobBlock(workflow, 'smoke')

    expect(smokeJob).toBeDefined()
    expect(smokeJob).toContain('env:\n      XID_CHROME_PATH: /usr/bin/google-chrome')
    expect(smokeJob).toContain('- run: pnpm smoke:three-workers')
    expect(smokeJob).toContain('- run: pnpm smoke:l2-l3')
  })

  it('rejects tracked private-key fixtures', () => {
    const result = spawnSync('node', [secretScannerPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS secret fixture scan')
  })

  it('pins every CI action to an immutable commit SHA', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const actionReferences = [...workflow.matchAll(/^\s*- uses:\s+([^\s]+)$/gmu)].map(
      (match) => match[1],
    )

    expect(actionReferences.length).toBeGreaterThan(0)
    for (const reference of actionReferences) {
      expect(isImmutableActionReference(reference)).toBe(true)
    }
    expect(isImmutableActionReference('actions/checkout@v4')).toBe(false)
  })
})
