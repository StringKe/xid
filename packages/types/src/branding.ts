export const BRAND_RADII = ['square', 'small', 'medium', 'round'] as const
export type BrandRadius = (typeof BRAND_RADII)[number]

export const BRAND_COLOR_SCHEMES = ['light', 'dark', 'system'] as const
export type BrandColorScheme = (typeof BRAND_COLOR_SCHEMES)[number]

export type OrgBranding = {
  primaryColor: string | null
  backgroundColor: string | null
  accentColor: string | null
  borderRadius: BrandRadius | null
  fontFamily: string | null
  logoUrl: string | null
  logoDarkUrl: string | null
  colorScheme: BrandColorScheme | null
}

export const ORG_BRANDING_FIELDS = [
  'primaryColor',
  'backgroundColor',
  'accentColor',
  'borderRadius',
  'fontFamily',
  'logoUrl',
  'logoDarkUrl',
  'colorScheme',
] as const satisfies readonly (keyof OrgBranding)[]

export const DEFAULT_ORG_BRANDING: OrgBranding = {
  primaryColor: null,
  backgroundColor: null,
  accentColor: null,
  borderRadius: null,
  fontFamily: null,
  logoUrl: null,
  logoDarkUrl: null,
  colorScheme: null,
}

// 圆角档位写入 Hosted UI 的 --xid-radius,沿用 tokens 的 0 / sm / 默认 / lg 梯度。
export const BRAND_RADIUS_CSS: Readonly<Record<BrandRadius, string>> = {
  square: '0',
  small: '0.25rem',
  medium: '0.375rem',
  round: '0.625rem',
}

const BRAND_COLOR = /^#[0-9a-fA-F]{6}$/
// v0.0.19 及更早版本把圆角存成 CSS 长度,读取时映射到最近的档位。
const LEGACY_BRAND_RADIUS = /^(\d{1,2}(?:\.\d{1,3})?)(px|rem|em)?$/
const LEGACY_RADIUS_UPPER_PX: readonly (readonly [number, BrandRadius])[] = [
  [0, 'square'],
  [4, 'small'],
  [7, 'medium'],
]
// 品牌值直接写入 CSS 自定义属性,只放行字体名需要的字符,拒绝 ; { } ( ) 等可拼接声明的符号。
const BRAND_FONT_FAMILY = /^[A-Za-z0-9 ,"'-]{1,120}$/

export function isBrandColor(value: string): boolean {
  return BRAND_COLOR.test(value)
}

export function isBrandRadius(value: string): value is BrandRadius {
  return (BRAND_RADII as readonly string[]).includes(value)
}

export function isBrandColorScheme(value: string): value is BrandColorScheme {
  return (BRAND_COLOR_SCHEMES as readonly string[]).includes(value)
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

export function brandRadiusFromLegacy(value: string): BrandRadius | null {
  const match = LEGACY_BRAND_RADIUS.exec(value)
  if (!match) return null
  const unit = match[2] ?? 'px'
  const px = Number(match[1]) * (unit === 'px' ? 1 : 16)
  return LEGACY_RADIUS_UPPER_PX.find(([upper]) => px <= upper)?.[1] ?? 'round'
}

const BRANDING_VALIDATORS: Record<keyof OrgBranding, (value: string) => boolean> = {
  primaryColor: isBrandColor,
  backgroundColor: isBrandColor,
  accentColor: isBrandColor,
  borderRadius: isBrandRadius,
  fontFamily: isBrandFontFamily,
  logoUrl: isBrandLogoUrl,
  logoDarkUrl: isBrandLogoUrl,
  colorScheme: isBrandColorScheme,
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
    if (typeof value !== 'string') continue
    if (field === 'borderRadius') {
      result.borderRadius = isBrandRadius(value) ? value : brandRadiusFromLegacy(value)
    } else if (field === 'colorScheme') {
      result.colorScheme = isBrandColorScheme(value) ? value : null
    } else if (isValidBrandingValue(field, value)) {
      result[field] = value
    }
  }
  return result
}

export function hasCustomBranding(branding: OrgBranding): boolean {
  return ORG_BRANDING_FIELDS.some((field) => branding[field] !== null)
}

export function sameOrgBranding(a: OrgBranding, b: OrgBranding): boolean {
  return ORG_BRANDING_FIELDS.every((field) => a[field] === b[field])
}

// Hosted UI 只用一个强调色:旧数据的 primaryColor 优先于 accentColor。
export function brandAccentOf(branding: OrgBranding): string | null {
  return branding.primaryColor ?? branding.accentColor
}
