// 与服务端发布校验(apps/server/worker/v1/org-branding.ts brandContrastChecks)同一算法,
// 输入时即可显示结果;最终以服务端发布为准。

import {
  CONTROL_CONTRAST,
  TEXT_CONTRAST,
  contrastRatio,
  deriveAccentPalette,
  ensureContrast,
  parseHexColor,
  toHex,
  type Rgb,
} from '@xid-kit/web-ui/brand-color'

export type BrandContrastKey = 'button_text' | 'link' | 'focus_ring'

export type BrandContrastCheck = {
  key: BrandContrastKey
  ratio: number
  minimum: number
  passes: boolean
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const DARK_SURFACE: Rgb = { r: 24, g: 24, b: 24 }

export function brandContrastChecks(accent: string): BrandContrastCheck[] {
  const rgb = parseHexColor(accent)
  const light = deriveAccentPalette(accent, 'light')
  const dark = deriveAccentPalette(accent, 'dark')
  const link = light ? parseHexColor(light.accent) : null
  const ring = dark ? parseHexColor(dark.accent) : null
  if (!rgb || !link || !ring) return []
  const checks: Omit<BrandContrastCheck, 'passes'>[] = [
    { key: 'button_text', ratio: contrastRatio(WHITE, rgb), minimum: TEXT_CONTRAST },
    { key: 'link', ratio: contrastRatio(link, WHITE), minimum: TEXT_CONTRAST },
    { key: 'focus_ring', ratio: contrastRatio(ring, DARK_SURFACE), minimum: CONTROL_CONTRAST },
  ]
  return checks.map((check) => ({ ...check, passes: check.ratio >= check.minimum }))
}

// 白字可读的最浅同色调深色,用作「Use #xxxxxx instead」。
export function suggestAccessibleAccent(accent: string): string | null {
  const rgb = parseHexColor(accent)
  if (!rgb) return null
  return toHex(ensureContrast(rgb, WHITE, TEXT_CONTRAST)).toUpperCase()
}

// 向下取一位小数,避免 4.46 显示成 4.5 却判为不通过。
export function formatContrastRatio(ratio: number): string {
  return (Math.floor(ratio * 10) / 10).toFixed(1)
}

export function linkColorFor(accent: string, scheme: 'light' | 'dark'): string | null {
  return deriveAccentPalette(accent, scheme)?.accent ?? null
}

export function accentWashFor(accent: string, scheme: 'light' | 'dark'): string | null {
  return deriveAccentPalette(accent, scheme)?.accentWash ?? null
}
