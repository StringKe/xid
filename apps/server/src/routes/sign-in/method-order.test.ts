import { describe, expect, it } from 'vitest'
import {
  LAST_AUTH_METHOD_KEY,
  defaultSecondStepMethod,
  identifierKindOf,
  readLastAuthMethod,
  secondStepMethods,
  writeLastAuthMethod,
} from './method-order'
import type { SignInMethod } from './shared'

const ALL: readonly SignInMethod[] = [
  'enterprise-sso',
  'passkey',
  'password',
  'magic-link',
  'otp-email',
  'otp-whatsapp',
  'otp-sms',
]

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage
}

describe('identifierKindOf', () => {
  it('treats anything with an at sign as an email address', () => {
    expect(identifierKindOf('dana@northwind.com', 'email_or_username')).toBe('email')
  })

  it('treats a digit string as a phone number outside email mode', () => {
    expect(identifierKindOf('+1 555 010 4417', 'email_or_username')).toBe('phone')
  })

  it('treats any other value as a username', () => {
    expect(identifierKindOf('dana.ortiz', 'username')).toBe('username')
  })

  it('always uses phone in phone identifier mode', () => {
    expect(identifierKindOf('5550104417', 'phone')).toBe('phone')
  })
})

describe('secondStepMethods', () => {
  it('orders codes ahead of the password and never offers enterprise SSO in the second step', () => {
    expect(secondStepMethods(ALL, 'email')).toEqual([
      'otp-email',
      'magic-link',
      'password',
      'passkey',
    ])
  })

  it('offers only phone channels for a phone number', () => {
    expect(secondStepMethods(ALL, 'phone')).toEqual([
      'otp-whatsapp',
      'otp-sms',
      'password',
      'passkey',
    ])
  })

  it('offers no code delivery for a username', () => {
    expect(secondStepMethods(ALL, 'username')).toEqual(['password', 'passkey'])
  })

  it('drops methods the tenant has not enabled', () => {
    expect(secondStepMethods(['password', 'magic-link'], 'email')).toEqual([
      'magic-link',
      'password',
    ])
  })
})

describe('defaultSecondStepMethod', () => {
  it('defaults to the first code method when the browser has no history', () => {
    expect(defaultSecondStepMethod(['otp-email', 'password', 'passkey'], null)).toBe('otp-email')
  })

  it('prefers the method this browser used last when it is still offered', () => {
    expect(defaultSecondStepMethod(['otp-email', 'password'], 'password')).toBe('password')
  })

  it('ignores a remembered method the tenant no longer offers', () => {
    expect(defaultSecondStepMethod(['otp-email', 'password'], 'passkey')).toBe('otp-email')
  })

  it('does not default to a passkey without browser history', () => {
    expect(defaultSecondStepMethod(['passkey', 'password'], null)).toBe('password')
  })

  it('returns null when no method is offered', () => {
    expect(defaultSecondStepMethod([], null)).toBeNull()
  })
})

describe('last used method storage', () => {
  it('round-trips a sign-in method under the documented key', () => {
    const storage = memoryStorage()

    writeLastAuthMethod(storage, 'password')

    expect(storage.getItem(LAST_AUTH_METHOD_KEY)).toBe('password')
    expect(readLastAuthMethod(storage)).toBe('password')
  })

  it('ignores an unknown stored value', () => {
    expect(readLastAuthMethod(memoryStorage({ [LAST_AUTH_METHOD_KEY]: 'telepathy' }))).toBeNull()
  })

  it('treats blocked storage as empty', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    }

    expect(readLastAuthMethod(blocked)).toBeNull()
  })
})
