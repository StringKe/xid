// light/dark + 运行时品牌覆盖:darkTheme class 必须挂 documentElement(body 背景、portal、
// top-layer dialog 在 React 树外,挂内层会停在 light 基线);品牌色用 inline --xid-* 覆盖。

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { darkTheme } from './styles/tokens.stylex'
import { BRAND_LOGO_TRANSPARENT } from './brand-assets'

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]
type ResolvedScheme = 'light' | 'dark'

export type BrandPalette = {
  primary: string
  primaryForeground: string
  background: string
  foreground: string
  muted: string
  mutedForeground: string
  accent: string
  border: string
  danger: string
  dangerForeground: string
}

export type BrandConfig = {
  light: BrandPalette
  dark: BrandPalette
  radius: string
  fontFamily: string
  logoUrl?: string
  appName?: string
}

const DEFAULT_LIGHT: BrandPalette = {
  primary: 'oklch(0.43 0.2 278)',
  primaryForeground: 'oklch(0.985 0.004 280)',
  background: 'oklch(0.985 0.004 282)',
  foreground: 'oklch(0.27 0.022 280)',
  muted: 'oklch(0.955 0.007 282)',
  mutedForeground: 'oklch(0.44 0.018 281)',
  accent: 'oklch(0.52 0.19 277)',
  border: 'oklch(0.9 0.008 282)',
  danger: 'oklch(0.55 0.2 25)',
  dangerForeground: 'oklch(0.985 0.004 280)',
}

const DEFAULT_DARK: BrandPalette = {
  primary: 'oklch(0.62 0.14 278)',
  primaryForeground: 'oklch(0.16 0.02 280)',
  background: 'oklch(0.18 0.022 280)',
  foreground: 'oklch(0.93 0.01 280)',
  muted: 'oklch(0.26 0.027 280)',
  mutedForeground: 'oklch(0.7 0.018 282)',
  accent: 'oklch(0.72 0.12 278)',
  border: 'oklch(0.32 0.028 280)',
  danger: 'oklch(0.68 0.17 25)',
  dangerForeground: 'oklch(0.16 0.02 280)',
}

export const DEFAULT_BRAND: BrandConfig = {
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  radius: '0.5rem',
  // 与 tokens.stylex.ts 的 --xid-font 保持同值。
  fontFamily:
    '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  logoUrl: BRAND_LOGO_TRANSPARENT,
  appName: 'XID',
}

function paletteToVars(brand: BrandConfig, scheme: ResolvedScheme): Record<string, string> {
  const palette = scheme === 'dark' ? brand.dark : brand.light
  return {
    '--xid-primary': palette.primary,
    '--xid-primary-foreground': palette.primaryForeground,
    '--xid-bg': palette.background,
    '--xid-fg': palette.foreground,
    '--xid-muted': palette.muted,
    '--xid-muted-foreground': palette.mutedForeground,
    '--xid-accent': palette.accent,
    '--xid-border': palette.border,
    '--xid-danger': palette.danger,
    '--xid-danger-foreground': palette.dangerForeground,
    '--xid-radius': brand.radius,
    '--xid-font': brand.fontFamily,
  }
}

// 默认 brand 不做 inline override,让 StyleX tokens/darkTheme 自然生效。
function isDefaultBrand(brand: BrandConfig): boolean {
  return brand === DEFAULT_BRAND
}

function prefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

const DARK_THEME_CLASSES = (stylex.props(darkTheme).className ?? '').split(' ').filter(Boolean)

// 与 tokens --xid-bg 对应;index.html 首帧兜底用同值。
const THEME_COLOR = { light: '#fafafc', dark: '#111318' } as const

function resolveScheme(mode: ThemeMode, systemDark: boolean): ResolvedScheme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

type ThemeContextValue = {
  brand: BrandConfig
  mode: ThemeMode
  scheme: ResolvedScheme
  setMode: (mode: ThemeMode) => void
  setBrand: (brand: BrandConfig) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export type ThemeProviderProps = {
  children: ReactNode
  initialBrand?: BrandConfig
  initialMode?: ThemeMode
}

export function ThemeProvider({
  children,
  initialBrand = DEFAULT_BRAND,
  initialMode = 'system',
}: ThemeProviderProps): ReactNode {
  const [brand, setBrand] = useState<BrandConfig>(initialBrand)
  const [mode, setMode] = useState<ThemeMode>(initialMode)
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark)

  // 监听始终挂着以保持 systemDark 准确(仅 mode=system 时影响渲染)。
  useEffect(() => {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const scheme = resolveScheme(mode, systemDark)
  const isDark = scheme === 'dark'
  const useDefaultBrand = isDefaultBrand(brand)

  // documentElement 上:darkTheme class + color-scheme + theme-color;自定义品牌再 inline 覆盖。
  useEffect(() => {
    const doc = globalThis.document
    if (!doc) return
    const root = doc.documentElement
    root.dataset.theme = scheme
    root.style.colorScheme = scheme
    for (const cls of DARK_THEME_CLASSES) root.classList.toggle(cls, isDark)
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[scheme])

    const names = Object.keys(paletteToVars(DEFAULT_BRAND, scheme))
    if (useDefaultBrand) {
      for (const name of names) root.style.removeProperty(name)
      return
    }
    const vars = paletteToVars(brand, scheme)
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  }, [brand, scheme, isDark, useDefaultBrand])

  const value = useMemo<ThemeContextValue>(
    () => ({ brand, mode, scheme, setMode, setBrand }),
    [brand, mode, scheme],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}

export function brandToCssVars(brand: BrandConfig, scheme: ResolvedScheme): Record<string, string> {
  return paletteToVars(brand, scheme)
}
