import { describe, it } from 'vitest'
import { runI18nRuntimeAudit } from './harness/i18n-runtime-audit.mjs'

describe('i18n runtime', () => {
  it('renders supported locales without source text leaks', async () => {
    await runI18nRuntimeAudit()
  }, 900000)
})
