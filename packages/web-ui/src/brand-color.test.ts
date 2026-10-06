import { describe, expect, it } from 'vitest'
import {
  CONTROL_CONTRAST,
  TEXT_CONTRAST,
  contrastRatio,
  deriveAccentPalette,
  parseHexColor,
  type ColorScheme,
} from './brand-color'

const WHITE = { r: 255, g: 255, b: 255 }
const DARK_SURFACE = { r: 24, g: 24, b: 24 }
const SURFACES: Record<ColorScheme, typeof WHITE> = { light: WHITE, dark: DARK_SURFACE }

function parsed(hex: string): { r: number; g: number; b: number } {
  const color = parseHexColor(hex)
  if (!color) throw new Error(`invalid test color ${hex}`)
  return color
}

describe('parseHexColor', () => {
  it('accepts six-digit and three-digit hex values', () => {
    expect(parseHexColor('#2e5fa3')).toEqual({ r: 46, g: 95, b: 163 })
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('rejects named colors, functions and malformed hex', () => {
    expect(parseHexColor('steelblue')).toBeNull()
    expect(parseHexColor('rgb(0 0 0)')).toBeNull()
    expect(parseHexColor('#12345')).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('matches the WCAG reference values for black and white', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, WHITE)).toBeCloseTo(21, 5)
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5)
  })
})

describe('deriveAccentPalette', () => {
  it.each(['#2e5fa3', '#ffd400', '#00ff88', '#ff00aa', '#111111', '#f5f5f5'])(
    'keeps accent text readable on the surface for %s in both schemes',
    (source) => {
      for (const scheme of ['light', 'dark'] as const) {
        const palette = deriveAccentPalette(source, scheme)
        if (!palette) throw new Error('palette missing')

        const accent = parsed(palette.accent)

        expect(contrastRatio(accent, SURFACES[scheme])).toBeGreaterThanOrEqual(TEXT_CONTRAST)
        expect(contrastRatio(parsed(palette.accentForeground), accent)).toBeGreaterThanOrEqual(
          TEXT_CONTRAST,
        )
        expect(contrastRatio(accent, parsed(palette.accentWash))).toBeGreaterThanOrEqual(
          CONTROL_CONTRAST,
        )
      }
    },
  )

  it('keeps an already compliant accent unchanged', () => {
    expect(deriveAccentPalette('#2e5fa3', 'light')?.accent).toBe('#2e5fa3')
  })

  it('darkens a bright yellow until it passes on white', () => {
    const palette = deriveAccentPalette('#ffd400', 'light')

    expect(palette?.accent).not.toBe('#ffd400')
  })

  it('returns null for colors it cannot parse', () => {
    expect(deriveAccentPalette('tomato', 'light')).toBeNull()
  })
})
