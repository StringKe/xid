import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..', '..', '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml')
const packageJsonPath = join(repoRoot, 'package.json')
const secretScannerPath = join(scriptDir, '..', 'check-repository-secrets.mjs')

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
