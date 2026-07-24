import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runGoalReadinessAudit } from './harness/goal-readiness-audit.mjs'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const readinessHarnessPath = join(testDirectory, 'harness', 'goal-readiness-audit.mjs')

describe('goal readiness', () => {
  it('has all production completion gates satisfied', async () => {
    await runGoalReadinessAudit()
  }, 300000)

  it('does not accept file or environment inputs as full L4 evidence', () => {
    const source = readFileSync(readinessHarnessPath, 'utf8')
    expect(source).not.toContain('passwordResetFullInputReady')
    expect(source).not.toContain('phoneOtpFullInputReady')
    expect(source).toContain('input files alone are not evidence')
  })
})
