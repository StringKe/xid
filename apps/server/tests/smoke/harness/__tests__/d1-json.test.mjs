import { describe, expect, it } from 'vitest'
import { parseD1Json } from '../d1-json.mjs'

describe('parseD1Json', () => {
  it('extracts a D1 JSON array after Wrangler notifications', () => {
    const stdout =
      'Cloudflare agent skills are available\n[notice] local mode\n[{"success":true,"results":[{"id":"row_1"}]}]\n'
    expect(parseD1Json(stdout, 'load fixture')).toEqual([
      { success: true, results: [{ id: 'row_1' }] },
    ])
  })

  it('keeps brackets and escaped quotes inside array strings', () => {
    const stdout =
      'notice\n[{"success":true,"results":[{"text":"value [ ] and \\"quoted\\""}]}]\ncomplete'
    expect(parseD1Json(stdout, 'read metadata')).toEqual([
      { success: true, results: [{ text: 'value [ ] and "quoted"' }] },
    ])
  })

  it('reports the operation and a safe output summary when no JSON array exists', () => {
    expect(() =>
      parseD1Json('Cloudflare agent skills\n[notice] unavailable', 'load admin user'),
    ).toThrow(
      'load admin user failed: no JSON array found; stdout=Cloudflare agent skills [notice] unavailable',
    )
  })
})
