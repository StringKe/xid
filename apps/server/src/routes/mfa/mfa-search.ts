export type MfaMethod = 'totp' | 'backup' | 'sms' | 'passkey'

export type MfaSearch = {
  method?: string
  step_up?: string
  redirect_to?: string
}

export function isMfaMethod(value: string | null): value is MfaMethod {
  return value === 'totp' || value === 'backup' || value === 'sms' || value === 'passkey'
}

// method 为 null 时回到方法选择页;step_up 与 redirect_to 始终保留。
export function mfaMethodSearch(method: MfaMethod | null, search: MfaSearch): string {
  const params = new URLSearchParams()
  if (method) params.set('method', method)
  if (search.step_up === '1') params.set('step_up', '1')
  if (search.redirect_to) params.set('redirect_to', search.redirect_to)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function availableFactorMethods(
  factors: readonly { type: 'totp' | 'backup_codes' | 'sms' | 'passkey' }[],
): MfaMethod[] {
  const methods: MfaMethod[] = []
  if (factors.some((factor) => factor.type === 'totp')) methods.push('totp')
  if (factors.some((factor) => factor.type === 'backup_codes')) methods.push('backup')
  if (factors.some((factor) => factor.type === 'sms')) methods.push('sms')
  if (factors.some((factor) => factor.type === 'passkey')) methods.push('passkey')
  return methods
}
