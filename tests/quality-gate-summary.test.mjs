// 质量门禁:关键目录测试文件数与 it() 下限,防止大面积误删回归测试。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** @type {ReadonlyArray<{ dir: string; label: string; minFiles: number; minTests: number }>} */
const AREA_MINIMUMS = [
  { dir: 'apps/server/worker/auth/__tests__', label: 'worker auth', minFiles: 8, minTests: 50 },
  { dir: 'apps/server/worker/oidc/__tests__', label: 'worker oidc', minFiles: 5, minTests: 40 },
  { dir: 'apps/server/worker/crons/__tests__', label: 'worker crons', minFiles: 7, minTests: 35 },
  { dir: 'apps/server/worker/v1/__tests__', label: 'management v1', minFiles: 1, minTests: 80 },
  { dir: 'packages/protocol/src/__tests__', label: 'protocol kernel', minFiles: 3, minTests: 15 },
  { dir: 'packages/crypto/src/__tests__', label: 'crypto kernel', minFiles: 2, minTests: 8 },
  { dir: 'packages/webauthn/src/__tests__', label: 'webauthn kernel', minFiles: 1, minTests: 10 },
  { dir: 'packages/db/src/__tests__', label: 'db tenant layer', minFiles: 1, minTests: 3 },
]

function countTests(source) {
  const itMatches = source.match(/^\s*it(?:\.each)?\s*\(/gm) ?? []
  const testMatches = source.match(/^\s*test\s*\(/gm) ?? []
  return itMatches.length + testMatches.length
}

function scanArea(dir) {
  const files = readdirSync(dir).filter(
    (name) => name.endsWith('.test.ts') || name.endsWith('.test.mjs'),
  )
  let tests = 0
  for (const file of files) {
    tests += countTests(readFileSync(join(dir, file), 'utf8'))
  }
  return { files: files.length, tests }
}

describe('quality gate area minimums', () => {
  for (const area of AREA_MINIMUMS) {
    it(`maintains ${area.label} test footprint under ${area.dir}`, () => {
      expect(existsSync(area.dir), `missing test directory: ${area.dir}`).toBe(true)
      const { files, tests } = scanArea(area.dir)
      expect(
        files,
        `${area.dir} regressed below ${area.minFiles} test files`,
      ).toBeGreaterThanOrEqual(area.minFiles)
      expect(
        tests,
        `${area.dir} regressed below ${area.minTests} it() blocks`,
      ).toBeGreaterThanOrEqual(area.minTests)
    })
  }
})

describe('quality gate root scripts', () => {
  it('check pipeline includes key-path and protocol source-map gates', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const check = pkg.scripts?.check ?? ''
    expect(check).toContain('test:key-paths')
    expect(check).toContain('test:coverage-gate')
    expect(check).toContain('protocols:source-map')
    expect(check).toContain('i18n:audit')
  })

  it('key-path checklist covers cron signing and SAML negative paths', () => {
    const source = readFileSync('tests/key-path-checklist.test.mjs', 'utf8')
    expect(source).toContain('signing-rotation-flow.test.ts')
    expect(source).toContain('daily-saml-poll.test.ts')
    expect(source).toContain('password.test.ts')
  })
})
