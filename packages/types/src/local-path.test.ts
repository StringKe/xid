import { describe, expect, it } from 'vitest'
import { MAX_LOCAL_PATH_LENGTH, normalizeLocalPath } from './local-path'

describe('normalizeLocalPath', () => {
  it('keeps a local path with query and hash', () => {
    expect(normalizeLocalPath('/authorize?authz_request_id=a&client_id=b#x')).toBe(
      '/authorize?authz_request_id=a&client_id=b#x',
    )
  })

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    '\\\\evil.example',
    '/\t/evil.example',
    '/account\n',
    '/.//evil.example/steal',
    '/a/..//evil.example',
    '/%2e//evil.example',
    'account',
    '',
  ])('rejects %j', (value) => {
    expect(normalizeLocalPath(value)).toBeNull()
  })

  it('rejects null, undefined and oversized input', () => {
    expect(normalizeLocalPath(null)).toBeNull()
    expect(normalizeLocalPath(undefined)).toBeNull()
    expect(normalizeLocalPath(`/${'a'.repeat(MAX_LOCAL_PATH_LENGTH)}`)).toBeNull()
  })

  it('normalizes dot segments without leaving the origin', () => {
    expect(normalizeLocalPath('/a/../account')).toBe('/account')
  })
})
