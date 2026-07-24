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

const NATIVE_JOB_NAMES = [
  'native-linux',
  'native-flutter',
  'native-ios',
  'native-android',
  'native-server',
  'native-dotnet',
]

// 取单个 job 的完整 YAML 块。job 键固定 2 空格缩进,块在下一个 2 空格顶层键(或注释)前结束。
function jobBlock(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  if (start === -1) return undefined
  const body = workflow.slice(start + 1)
  const next = body.slice(1).search(/\n {2}[A-Za-z#]/u)
  return next === -1 ? body : body.slice(0, next + 1)
}

describe('CI release contract', () => {
  it('covers native SDK paths and security gates without a production deploy credential', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

    expect(workflow).toContain('native-linux:')
    expect(workflow).toContain('native-flutter:')
    expect(workflow).toContain('native-ios:')
    const nativeFilters = [
      'linux',
      'flutter',
      'ios',
      'macos',
      'android',
      'server',
      'dotnet',
      'windows',
    ]
    // 内核路径已从 filter 移除(SDK 目录对 packages/* 的引用数为 0),剩下的共享路径是
    // workflow 本体和契约测试本体 -- 改了它们必须重跑全部原生 SDK job。
    const sharedContractPaths = [
      "'.github/workflows/ci.yml'",
      "'tests/native-sdk-contract.test.mjs'",
    ]
    for (const filter of nativeFilters) {
      const line = workflow.match(new RegExp(`^\\s*${filter}: \\[([^\\n]+)\\]$`, 'mu'))?.[0]
      expect(line).toBeDefined()
      for (const path of sharedContractPaths) expect(line).toContain(path)
    }
    expect(workflow).toContain('cargo test')
    expect(workflow).toContain('flutter test')
    expect(workflow).toContain('swift test')
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

  it('runs every native SDK job on push even when the paths filter is skipped', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    // squash + force-push 后 github.event.before 变成 orphan SHA,paths-filter 会 throw。
    // changes 只在 PR 上跑,下游必须用 always() 才不会被连带 skip。
    expect(workflow).toMatch(/^ {2}changes:\n {4}if: github\.event_name == 'pull_request'$/mu)

    for (const name of NATIVE_JOB_NAMES) {
      const job = jobBlock(workflow, name)
      expect(job, `missing ${name} job`).toBeDefined()
      expect(job, `${name} must not gate on a skipped changes job`).toContain('always()')
      expect(job, `${name} must still run on push`).toContain("github.event_name != 'pull_request'")
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
