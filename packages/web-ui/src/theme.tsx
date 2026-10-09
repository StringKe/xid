// light/dark + 运行时品牌覆盖:darkTheme class 必须挂 documentElement(body 背景、portal、
// top-layer dialog 在 React 树外,挂内层会停在 light 基线);品牌只 inline 覆盖 accent 家族与圆角。
// 品牌固定的配色只影响当前页面,不写入访客保存的明暗偏好。

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { darkTheme } from './styles/tokens.stylex'
import { BRAND_LOGO_TRANSPARENT } from './brand-assets'
import { deriveAccentPalette, type ColorScheme } from './brand-color'
import { BRAND_RADIUS_CSS, hasCustomBranding, type OrgBranding } from '@xid-kit/types'
import {
  THEME_COLOR,
  THEME_STORAGE_KEY,
  persistThemeMode,
  readThemeMode,
  resolveThemeScheme,
  type ThemeMode,
} from './theme-preference'

export { THEME_MODES, THEME_STORAGE_KEY } from './theme-preference'
export type { ThemeMode } from './theme-preference'
type ResolvedScheme = ColorScheme

export type BrandConfig = {
  accent: string | null
  radius: string | null
  // 组织固定的配色;null 时跟随访客自己的明暗偏好。
  scheme?: ResolvedScheme | null
  logoUrl?: string
  logoDarkUrl?: string
  appName?: string
}

export const DEFAULT_BRAND: BrandConfig = {
  accent: null,
  radius: null,
  scheme: null,
  logoUrl: BRAND_LOGO_TRANSPARENT,
  appName: 'XID',
}

export const BRAND_CSS_VARS = [
  '--xid-accent',
  '--xid-accent-strong',
  '--xid-accent-wash',
  '--xid-accent-foreground',
  '--xid-info',
  '--xid-info-bg',
  '--xid-info-foreground',
  '--xid-radius',
] as const

export function brandFromOrgBranding(branding: OrgBranding | null | undefined): BrandConfig {
  if (!branding || !hasCustomBranding(branding)) return DEFAULT_BRAND
  return {
    accent: branding.primaryColor ?? branding.accentColor ?? null,
    radius: branding.borderRadius ? BRAND_RADIUS_CSS[branding.borderRadius] : null,
    scheme:
      branding.colorScheme === 'light' || branding.colorScheme === 'dark'
        ? branding.colorScheme
        : null,
    logoUrl: branding.logoUrl ?? DEFAULT_BRAND.logoUrl,
    logoDarkUrl: branding.logoDarkUrl ?? branding.logoUrl ?? DEFAULT_BRAND.logoUrl,
    appName: DEFAULT_BRAND.appName,
  }
}

export function brandLogoUrl(brand: BrandConfig, scheme: ResolvedScheme): string | undefined {
  return scheme === 'dark' ? (brand.logoDarkUrl ?? brand.logoUrl) : brand.logoUrl
}

export function brandToCssVars(brand: BrandConfig, scheme: ResolvedScheme): Record<string, string> {
  const vars: Record<string, string> = {}
  const palette = brand.accent ? deriveAccentPalette(brand.accent, scheme) : null
  if (palette) {
    vars['--xid-accent'] = palette.accent
    vars['--xid-accent-strong'] = palette.accentStrong
    vars['--xid-accent-wash'] = palette.accentWash
    vars['--xid-accent-foreground'] = palette.accentForeground
    vars['--xid-info'] = palette.accent
    vars['--xid-info-bg'] = palette.accentWash
    vars['--xid-info-foreground'] = palette.accentForeground
  }
  if (brand.radius) vars['--xid-radius'] = brand.radius
  return vars
}

function prefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

const DARK_THEME_CLASSES = (stylex.props(darkTheme).className ?? '').split(' ').filter(Boolean)

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
  initialMode,
}: ThemeProviderProps): ReactNode {
  const [brand, setBrand] = useState<BrandConfig>(initialBrand)
  const [mode, setModeState] = useState<ThemeMode>(() => initialMode ?? readThemeMode())
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark)

  useEffect(() => {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === THEME_STORAGE_KEY) setModeState(readThemeMode())
    }
    globalThis.addEventListener?.('storage', onStorage)
    return () => globalThis.removeEventListener?.('storage', onStorage)
  }, [])

  const setMode = useCallback((next: ThemeMode): void => {
    persistThemeMode(next)
    setModeState(next)
  }, [])

  const scheme = brand.scheme ?? resolveThemeScheme(mode, systemDark)
  const isDark = scheme === 'dark'

  useEffect(() => {
    const doc = globalThis.document
    if (!doc) return
    const root = doc.documentElement
    root.dataset.theme = scheme
    root.style.colorScheme = scheme
    for (const cls of DARK_THEME_CLASSES) root.classList.toggle(cls, isDark)
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[scheme])

    const vars = brandToCssVars(brand, scheme)
    for (const name of BRAND_CSS_VARS) {
      const value = vars[name]
      if (value) root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
  }, [brand, scheme, isDark])

  const value = useMemo<ThemeContextValue>(
    () => ({ brand, mode, scheme, setMode, setBrand }),
    [brand, mode, scheme, setMode],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
