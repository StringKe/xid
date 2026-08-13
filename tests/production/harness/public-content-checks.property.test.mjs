import fc from 'fast-check'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { llmsOk } from './public-content-checks.mjs'

const llmsPath = new URL('../../../apps/site/dist/llms.txt', import.meta.url)

describe('public content check properties', () => {
  it('rejects every internal design target', async () => {
    const llms = await readFile(llmsPath, 'utf8')
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), (suffix) => {
        const path = encodeURIComponent(suffix)
        const target = new URL(`/docs/design/${path}`, 'https://xid.dev')
        fc.pre(target.pathname.startsWith('/docs/design/'))
        const injected = `${llms}\n- [Internal](${target.href})\n`

        expect(llmsOk(injected)).toBe(false)
      }),
      { numRuns: 500 },
    )
  })
})
