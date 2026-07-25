import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { llmsFullOk, llmsOk } from './harness/public-content-checks.mjs'

const llmsPath = new URL('../../apps/server/public/llms.txt', import.meta.url)
const llmsFullPath = new URL('../../apps/server/public/llms-full.txt', import.meta.url)

describe('production public content checks', () => {
  it('accepts the generated public indexes', async () => {
    const [llms, llmsFull] = await Promise.all([
      readFile(llmsPath, 'utf8'),
      readFile(llmsFullPath, 'utf8'),
    ])

    expect(llmsOk(llms)).toBe(true)
    expect(llmsFullOk(llmsFull)).toBe(true)
  })

  it('rejects internal design targets', async () => {
    const llms = await readFile(llmsPath, 'utf8')
    const injected = `${llms}\n- [Internal](https://xid.dev/docs/design/00-overview)\n`

    expect(llmsOk(injected)).toBe(false)
  })
})
