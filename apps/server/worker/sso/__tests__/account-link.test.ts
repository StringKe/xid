// account-link.ts:HRD 与 JIT 共用的 org 域名覆盖规则。

import { describe, expect, it } from 'vitest'
import { orgDomainCovers, parentDomains } from '../account-link'

describe('parentDomains', () => {
  it('lists every parent with at least two labels, nearest first', () => {
    expect(parentDomains('a.b.example.com')).toEqual(['b.example.com', 'example.com'])
  })

  it('returns nothing for a registrable two-label domain', () => {
    expect(parentDomains('example.com')).toEqual([])
  })
})

describe('orgDomainCovers', () => {
  it('matches the exact domain without wildcard', () => {
    expect(orgDomainCovers({ domain: 'example.com', isWildcard: false }, 'example.com')).toBe(true)
  })

  it('covers deep subdomains through a wildcard parent', () => {
    expect(orgDomainCovers({ domain: 'example.com', isWildcard: true }, 'a.b.example.com')).toBe(
      true,
    )
  })

  it('does not cover subdomains without wildcard', () => {
    expect(orgDomainCovers({ domain: 'example.com', isWildcard: false }, 'a.example.com')).toBe(
      false,
    )
  })

  it('does not match a lookalike suffix', () => {
    expect(orgDomainCovers({ domain: 'example.com', isWildcard: true }, 'badexample.com')).toBe(
      false,
    )
  })
})
