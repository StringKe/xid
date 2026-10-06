// 租户只提供一个强调色;hover、浅底和前景色由此派生,并保证与表面色的 WCAG 对比度。

export type ColorScheme = 'light' | 'dark'

export type Rgb = { r: number; g: number; b: number }

export type AccentPalette = {
  accent: string
  accentStrong: string
  accentWash: string
  accentForeground: string
}

export const TEXT_CONTRAST = 4.5
export const CONTROL_CONTRAST = 3

const SURFACE: Record<ColorScheme, Rgb> = {
  light: { r: 255, g: 255, b: 255 },
  dark: { r: 24, g: 24, b: 24 },
}
const GROUND: Record<ColorScheme, Rgb> = {
  light: { r: 246, g: 246, b: 246 },
  dark: { r: 17, g: 17, b: 17 },
}
const DARK_LABEL: Rgb = { r: 20, g: 20, b: 20 }
const LIGHT_LABEL: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }
const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const MAX_ADJUST_STEPS = 20

export function parseHexColor(value: string): Rgb | null {
  const trimmed = value.trim()
  if (!HEX_PATTERN.test(trimmed)) return null
  const digits = trimmed.slice(1)
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

function channelLuminance(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  }
}

function roundRgb(color: Rgb): Rgb {
  return { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) }
}

// 逐步向黑(浅色)或向白(深色)靠,直到在表面上达到正文对比度。
export function ensureContrast(color: Rgb, background: Rgb, minimum: number): Rgb {
  const target = relativeLuminance(background) > 0.5 ? BLACK : WHITE
  let current = roundRgb(color)
  for (let step = 0; step < MAX_ADJUST_STEPS; step += 1) {
    if (contrastRatio(current, background) >= minimum) return current
    current = roundRgb(mix(current, target, 0.1))
  }
  return target
}

export function readableLabel(fill: Rgb): Rgb {
  return contrastRatio(LIGHT_LABEL, fill) >= contrastRatio(DARK_LABEL, fill)
    ? LIGHT_LABEL
    : DARK_LABEL
}

export function deriveAccentPalette(source: string, scheme: ColorScheme): AccentPalette | null {
  const parsed = parseHexColor(source)
  if (!parsed) return null
  const surface = SURFACE[scheme]
  const onShell = ensureContrast(
    ensureContrast(parsed, surface, TEXT_CONTRAST),
    GROUND[scheme],
    TEXT_CONTRAST,
  )
  const accentWash = roundRgb(mix(surface, onShell, scheme === 'light' ? 0.1 : 0.18))
  const accent = ensureContrast(onShell, accentWash, TEXT_CONTRAST)
  const strongTarget = scheme === 'light' ? BLACK : WHITE
  const accentStrong = roundRgb(mix(accent, strongTarget, scheme === 'light' ? 0.2 : 0.3))
  return {
    accent: toHex(accent),
    accentStrong: toHex(accentStrong),
    accentWash: toHex(accentWash),
    accentForeground: toHex(readableLabel(accent)),
  }
}
