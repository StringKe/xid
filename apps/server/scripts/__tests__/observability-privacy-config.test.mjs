import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseJsonc } from '../../../../scripts/verify-worker-routes.mjs'

function readWrangler(relativeUrl) {
  const path = fileURLToPath(new URL(relativeUrl, import.meta.url))
  return parseJsonc(readFileSync(path, 'utf8'), path)
}

const core = readWrangler('../../wrangler.jsonc')
const site = readWrangler('../../../site/wrangler.jsonc')
const consoleWorker = readWrangler('../../../console/wrangler.jsonc')

function expectPrivateObservability(observability, samplingRate) {
  expect(observability).toEqual({
    enabled: true,
    head_sampling_rate: samplingRate,
    logs: {
      enabled: true,
      head_sampling_rate: samplingRate,
      persist: true,
      invocation_logs: false,
    },
    traces: {
      enabled: false,
      persist: false,
    },
  })
}

describe('Worker observability privacy config', () => {
  it('locks Core production sampling to 0.1 and staging sampling to 1', () => {
    expectPrivateObservability(core.observability, 0.1)
    expectPrivateObservability(core.env.staging.observability, 1)
  })

  it('gives Site and Console an explicit production-safe policy', () => {
    expectPrivateObservability(site.observability, 0.1)
    expectPrivateObservability(consoleWorker.observability, 0.1)
  })

  it('preserves dashboard-managed non-secret Core variables across Workers Builds deploys', () => {
    expect(core.keep_vars).toBe(true)
  })
})
