// 手机号统一为 E.164:同一号码的不同书写必须落到同一个查库、限流和存储键。

const E164_PATTERN = /^\+[1-9]\d{6,14}$/
const PHONE_SEPARATORS = /[\s().-]/g

export function normalizePhoneNumber(value: string): string | null {
  const compact = value.trim().replace(PHONE_SEPARATORS, '')
  return E164_PATTERN.test(compact) ? compact : null
}
