import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('NotFoundPage title contract', () => {
  it('passes the localized page title to Nimbus exactly once', async () => {
    const source = await readFile(new URL('./NotFoundPage.astro', import.meta.url), 'utf8')

    expect(source).toContain('title={pageNotFound}')
    expect(source).not.toContain('virtual:nimbus/config')
    expect(source).not.toContain('config.title')
  })
})
