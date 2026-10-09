import { describe, expect, it } from 'vitest'
import { evaluateScimFilter, getGroupFilterValue, getUserFilterValue } from '../filter-eval'
import { ENTERPRISE_USER_SCHEMA, parseScimFilter, parseScimPatchPath } from '../filter-parser'

const user = {
  id: 'u1',
  tenantId: 't_1',
  directoryId: 'dir_1',
  userId: null,
  externalId: 'ext-1',
  userName: 'Brandon@example.com',
  scimRaw: {
    emails: [
      { type: 'home', value: 'home@example.com' },
      { type: 'work', value: 'work@example.com' },
    ],
    [ENTERPRISE_USER_SCHEMA]: { department: 'Sales and Ops' },
  },
  active: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

function matches(filter: string): boolean {
  const parsed = parseScimFilter(filter)
  if (!parsed.ok || !parsed.expr) throw new Error(`filter did not parse: ${filter}`)
  return evaluateScimFilter(parsed.expr, user, getUserFilterValue)
}

describe('parseScimFilter', () => {
  it('keeps and/or inside a quoted value as part of the value', () => {
    const parsed = parseScimFilter('displayName eq "Brand and Orders or Ops"')

    expect(parsed).toEqual({
      ok: true,
      expr: { kind: 'compare', path: ['displayName'], op: 'eq', value: 'Brand and Orders or Ops' },
    })
  })

  it('binds not tighter than and, and tighter than or', () => {
    const parsed = parseScimFilter('active eq true or not (userName pr) and externalId eq "x"')

    expect(parsed.ok && parsed.expr?.kind).toBe('or')
    if (!parsed.ok || parsed.expr?.kind !== 'or') throw new Error('unexpected shape')
    expect(parsed.expr.right.kind).toBe('and')
  })

  it('evaluates a valuePath filter against any element of a multi-valued attribute', () => {
    expect(matches('emails[type eq "work" and value co "work@"]')).toBe(true)
    expect(matches('emails[type eq "other"]')).toBe(false)
  })

  it('reads enterprise extension attributes through the URN prefix', () => {
    expect(matches(`${ENTERPRISE_USER_SCHEMA}:department eq "sales and ops"`)).toBe(true)
  })

  it('treats userName as case-insensitive and externalId as case-exact', () => {
    expect(matches('userName eq "brandon@EXAMPLE.com"')).toBe(true)
    expect(matches('externalId eq "EXT-1"')).toBe(false)
  })

  it('rejects unterminated strings, unknown operators and trailing tokens', () => {
    expect(parseScimFilter('userName eq "alice').ok).toBe(false)
    expect(parseScimFilter('userName unknown "alice"').ok).toBe(false)
    expect(parseScimFilter('userName eq "a" "b"').ok).toBe(false)
    expect(parseScimFilter('emails.value co example.com').ok).toBe(false)
  })

  it('matches members[value eq "x"] on a group', () => {
    const parsed = parseScimFilter('members[value eq "m2"]')
    if (!parsed.ok || !parsed.expr) throw new Error('filter did not parse')
    const group = {
      id: 'g1',
      tenantId: 't_1',
      directoryId: 'dir_1',
      displayName: 'Ops',
      createdAt: null,
      updatedAt: null,
    }

    const hit = evaluateScimFilter(parsed.expr, group, (row, path) =>
      getGroupFilterValue(row, path, new Set(['m1', 'm2'])),
    )

    expect(hit).toBe(true)
  })
})

describe('parseScimPatchPath', () => {
  it('parses a sub-attribute path', () => {
    expect(parseScimPatchPath('name.familyName')).toEqual({
      ok: true,
      path: { attrPath: { attr: 'name', sub: 'familyName' } },
    })
  })

  it('parses a value path with a trailing sub-attribute', () => {
    const parsed = parseScimPatchPath('emails[type eq "work"].value')

    expect(parsed.ok && parsed.path.sub).toBe('value')
    expect(parsed.ok && parsed.path.filter?.kind).toBe('compare')
  })

  it('strips the core schema URN and keeps the enterprise schema URN', () => {
    expect(parseScimPatchPath('urn:ietf:params:scim:schemas:core:2.0:User:password')).toEqual({
      ok: true,
      path: { attrPath: { attr: 'password' } },
    })
    expect(parseScimPatchPath(`${ENTERPRISE_USER_SCHEMA}:manager.value`)).toEqual({
      ok: true,
      path: { attrPath: { schema: ENTERPRISE_USER_SCHEMA, attr: 'manager', sub: 'value' } },
    })
  })

  it('rejects malformed paths', () => {
    expect(parseScimPatchPath('members[value eq "x"').ok).toBe(false)
    expect(parseScimPatchPath('name..given').ok).toBe(false)
    expect(parseScimPatchPath('emails[type eq "work"]value').ok).toBe(false)
    expect(parseScimPatchPath('').ok).toBe(false)
  })
})
