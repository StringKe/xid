// Apple form_post 的 user 字段解析:只取姓名,格式不对时当作没有。

import { describe, expect, it } from 'vitest'
import { parseAppleUserName, withAppleUserName } from '../social-callback-params'
import type { ProviderProfile } from '../social-providers'

const baseProfile: ProviderProfile = {
  idpUserId: 'apple-001',
  email: 'relay@privaterelay.appleid.com',
  emailVerified: true,
  name: null,
  profileRaw: {},
}

describe('parseAppleUserName', () => {
  it('returns trimmed first and last name from the Apple user JSON', () => {
    const raw = JSON.stringify({
      name: { firstName: ' Ada ', lastName: 'Lovelace' },
      email: 'a@b.c',
    })

    expect(parseAppleUserName(raw)).toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
  })

  it('keeps a single name part and returns null for the missing one', () => {
    const raw = JSON.stringify({ name: { firstName: 'Ada' } })

    expect(parseAppleUserName(raw)).toEqual({ firstName: 'Ada', lastName: null })
  })

  it.each([
    ['missing field', null],
    ['empty string', ''],
    ['malformed JSON', '{"name":'],
    ['array payload', '[]'],
    ['non-string name part', JSON.stringify({ name: { firstName: 42 } })],
    ['blank name parts', JSON.stringify({ name: { firstName: '  ', lastName: '' } })],
    ['oversized name part', JSON.stringify({ name: { firstName: 'a'.repeat(129) } })],
    ['oversized payload', JSON.stringify({ name: { firstName: 'Ada' }, pad: 'x'.repeat(5000) })],
  ])('returns null for %s', (_label, raw) => {
    expect(parseAppleUserName(raw)).toBeNull()
  })
})

describe('withAppleUserName', () => {
  it('fills given, family and display name when the id_token has none', () => {
    const profile = withAppleUserName(baseProfile, { firstName: 'Ada', lastName: 'Lovelace' })

    expect(profile).toMatchObject({
      givenName: 'Ada',
      familyName: 'Lovelace',
      name: 'Ada Lovelace',
    })
  })

  it('does not override a name already present in the id_token', () => {
    const profile = withAppleUserName(
      { ...baseProfile, name: 'Token Name' },
      { firstName: 'Ada', lastName: null },
    )

    expect(profile.name).toBe('Token Name')
    expect(profile.givenName).toBeUndefined()
  })

  it('does not change identity or email fields', () => {
    const profile = withAppleUserName(baseProfile, { firstName: 'Ada', lastName: null })

    expect(profile).toMatchObject({
      idpUserId: 'apple-001',
      email: 'relay@privaterelay.appleid.com',
      emailVerified: true,
    })
  })
})
