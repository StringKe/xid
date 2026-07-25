import fc from 'fast-check'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { llmsOk } from './public-content-checks.mjs'

const llmsPath = new URL('../../../apps/server/public/llms.txt', import.meta.url)

describe('public content check properties', () => {
  it('rejects every internal design target', async () => {
    const llms = await readFile(llmsPath, 'utf8')
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), (suffix) => {
        const path = encodeURIComponent(suffix)
        const injected = `${llms}\n- [Internal](https://xid.dev/docs/design/${path})\n`

        expect(llmsOk(injected)).toBe(false)
      }),
      { numRuns: 500 },
    )
  })
})
