export type OrgBranding = {
  primaryColor: string | null
  backgroundColor: string | null
  accentColor: string | null
  borderRadius: string | null
  fontFamily: string | null
  logoUrl: string | null
  logoDarkUrl: string | null
}

export const ORG_BRANDING_FIELDS = [
  'primaryColor',
  'backgroundColor',
  'accentColor',
  'borderRadius',
  'fontFamily',
  'logoUrl',
  'logoDarkUrl',
] as const satisfies readonly (keyof OrgBranding)[]

export const DEFAULT_ORG_BRANDING: OrgBranding = {
  primaryColor: null,
  backgroundColor: null,
  accentColor: null,
  borderRadius: null,
  fontFamily: null,
  logoUrl: null,
  logoDarkUrl: null,
}

const BRAND_COLOR = /^#[0-9a-fA-F]{6}$/
const BRAND_RADIUS = /^(?:0|\d{1,2}(?:\.\d{1,3})?(?:px|rem|em))$/
// 品牌值直接写入 CSS 自定义属性,只放行字体名需要的字符,拒绝 ; { } ( ) 等可拼接声明的符号。
const BRAND_FONT_FAMILY = /^[A-Za-z0-9 ,"'-]{1,120}$/

export function isBrandColor(value: string): boolean {
  return BRAND_COLOR.test(value)
}

export function isBrandRadius(value: string): boolean {
  return BRAND_RADIUS.test(value)
}

export function isBrandFontFamily(value: string): boolean {
  return BRAND_FONT_FAMILY.test(value)
}

export function isBrandLogoUrl(value: string): boolean {
  if (value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

const BRANDING_VALIDATORS: Record<keyof OrgBranding, (value: string) => boolean> = {
  primaryColor: isBrandColor,
  backgroundColor: isBrandColor,
  accentColor: isBrandColor,
  borderRadius: isBrandRadius,
  fontFamily: isBrandFontFamily,
  logoUrl: isBrandLogoUrl,
  logoDarkUrl: isBrandLogoUrl,
}

export function isValidBrandingValue(field: keyof OrgBranding, value: string): boolean {
  return BRANDING_VALIDATORS[field](value)
}

// 存量数据可能早于校验写入,读取时丢弃不合法字段,渲染端只会拿到通过校验的值。
export function normalizeOrgBranding(raw: unknown): OrgBranding {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_ORG_BRANDING
  const record = raw as Record<string, unknown>
  const result: OrgBranding = { ...DEFAULT_ORG_BRANDING }
  for (const field of ORG_BRANDING_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && isValidBrandingValue(field, value)) result[field] = value
  }
  return result
}

export function hasCustomBranding(branding: OrgBranding): boolean {
  return ORG_BRANDING_FIELDS.some((field) => branding[field] !== null)
}
