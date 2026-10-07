export type MfaMethod = 'totp' | 'backup' | 'sms' | 'passkey'

export type MfaSearch = {
  method?: string
  step_up?: string
  redirect_to?: string
}

export function isMfaMethod(value: string | null): value is MfaMethod {
  return value === 'totp' || value === 'backup' || value === 'sms' || value === 'passkey'
}

// 方法选择页的 method 取值;缺省 method 时直接进入默认方法。
export const MFA_CHOOSER = 'choose'

// method 为 null 时回到方法选择页;step_up 与 redirect_to 始终保留。
export function mfaMethodSearch(method: MfaMethod | null, search: MfaSearch): string {
  const params = new URLSearchParams()
  params.set('method', method ?? MFA_CHOOSER)
  if (search.step_up === '1') params.set('step_up', '1')
  if (search.redirect_to) params.set('redirect_to', search.redirect_to)
  const query = params.toString()
  return query ? `?${query}` : ''
}

const FACTOR_ORDER: readonly MfaMethod[] = ['passkey', 'totp', 'sms', 'backup']

// step-up 不接受短信:短信码不能用来确认改动登录方式这类敏感操作。
export function availableFactorMethods(
  factors: readonly { type: 'totp' | 'backup_codes' | 'sms' | 'passkey' }[],
  options: { stepUp?: boolean } = {},
): MfaMethod[] {
  const owned = new Set<MfaMethod>(
    factors.map((factor) => (factor.type === 'backup_codes' ? 'backup' : factor.type)),
  )
  if (options.stepUp) owned.delete('sms')
  return FACTOR_ORDER.filter((method) => owned.has(method))
}

// 默认先给本浏览器上次用过的方法,其次验证器;备用码只在别无选择时成为默认。
export function defaultMfaMethod(
  methods: readonly MfaMethod[],
  lastUsed: MfaMethod | null,
): MfaMethod | null {
  if (lastUsed && methods.includes(lastUsed)) return lastUsed
  if (methods.includes('totp')) return 'totp'
  return methods.find((method) => method !== 'backup') ?? methods[0] ?? null
}

export const LAST_MFA_METHOD_KEY = 'xid.lastMfaMethod'

export function readLastMfaMethod(storage: Pick<Storage, 'getItem'> | null): MfaMethod | null {
  if (!storage) return null
  try {
    const value = storage.getItem(LAST_MFA_METHOD_KEY)
    return isMfaMethod(value) ? value : null
  } catch {
    return null
  }
}

export function writeLastMfaMethod(
  storage: Pick<Storage, 'setItem'> | null,
  method: MfaMethod,
): void {
  if (!storage) return
  try {
    storage.setItem(LAST_MFA_METHOD_KEY, method)
  } catch {
    return
  }
}
