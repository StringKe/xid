// 第二步可用方法与默认方法:只看租户已开放的方法、用户自己输入的标识符类型和本浏览器记住的上次方法,
// 从不按服务端用户数据决定(登录前不能告诉前端某个账号有没有 passkey 或密码)。

import type { PublicHostedAuthConfig } from './auth-config'
import type { SignInMethod } from './shared'

export type IdentifierKind = 'email' | 'phone' | 'username'

// OTP 优先于密码(租户同时开放时默认发码);passkey 只在上次用过时成为默认。
const SECOND_STEP_ORDER: readonly SignInMethod[] = [
  'otp-email',
  'otp-whatsapp',
  'otp-sms',
  'magic-link',
  'password',
  'passkey',
]

const METHODS_BY_KIND: Readonly<Record<IdentifierKind, ReadonlySet<SignInMethod>>> = {
  email: new Set(['otp-email', 'magic-link', 'password', 'passkey']),
  phone: new Set(['otp-sms', 'otp-whatsapp', 'password', 'passkey']),
  username: new Set(['password', 'passkey']),
}

const PHONE_PATTERN = /^\+?[\d\s().-]{6,}$/

export function identifierKindOf(
  value: string,
  mode: PublicHostedAuthConfig['identifierMode'],
): IdentifierKind {
  const trimmed = value.trim()
  if (mode === 'phone') return 'phone'
  if (trimmed.includes('@')) return 'email'
  if (mode === 'email') return 'email'
  return PHONE_PATTERN.test(trimmed) && /\d{6,}/.test(trimmed.replace(/\D/g, ''))
    ? 'phone'
    : 'username'
}

export function secondStepMethods(
  enabled: readonly SignInMethod[],
  kind: IdentifierKind,
): SignInMethod[] {
  const allowed = METHODS_BY_KIND[kind]
  return SECOND_STEP_ORDER.filter((method) => enabled.includes(method) && allowed.has(method))
}

export function defaultSecondStepMethod(
  methods: readonly SignInMethod[],
  lastUsed: SignInMethod | null,
): SignInMethod | null {
  if (lastUsed && methods.includes(lastUsed)) return lastUsed
  return methods.find((method) => method !== 'passkey') ?? methods[0] ?? null
}

export const LAST_AUTH_METHOD_KEY = 'xid.lastAuthMethod'

const STORABLE_METHODS: ReadonlySet<string> = new Set(SECOND_STEP_ORDER)

function isStorableMethod(value: string | null): value is SignInMethod {
  return value !== null && STORABLE_METHODS.has(value)
}

// localStorage 按 origin 天然隔离;隐私模式或禁用存储时读写失败只当作没有记录。
export function readLastAuthMethod(storage: Pick<Storage, 'getItem'> | null): SignInMethod | null {
  if (!storage) return null
  try {
    const value = storage.getItem(LAST_AUTH_METHOD_KEY)
    return isStorableMethod(value) ? value : null
  } catch {
    return null
  }
}

export function writeLastAuthMethod(
  storage: Pick<Storage, 'setItem'> | null,
  method: SignInMethod,
): void {
  if (!storage || !STORABLE_METHODS.has(method)) return
  try {
    storage.setItem(LAST_AUTH_METHOD_KEY, method)
  } catch {
    return
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
