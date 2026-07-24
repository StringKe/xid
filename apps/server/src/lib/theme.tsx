// ThemeProvider:StyleX tokens(--xid-*)为底座,light/dark + 运行时品牌覆盖三层叠加。
//   1. tokens(defineVars)默认值 = light 基线,已注入全局 CSS。
//   2. dark:挂 darkTheme(createTheme 生成的 className)到 documentElement,整页切 dark。
//      必须挂 html 而不是 React 树内层容器:body 背景(styles.css 的 var(--xid-bg))、
//      portal、top-layer dialog 都在 React 容器之外,挂内层会让它们停在 light 基线。
//   3. brand:来自租户/org 品牌配置(KV brand:{tenant_id}[:{org_id}],见 cloudflare-bindings rule),
//      对同名 --xid-* CSS 变量做 inline override(per-org 覆盖 per-tenant 覆盖默认)。
//      StyleX defineVars 用显式 --xid-* 键,生成的变量名即此名,故 inline setProperty 直接命中。
//      dark 时 darkTheme 始终在挂(品牌只覆盖品牌色,语义色/阴影/层次色仍需随 dark 翻转),
//      inline 变量优先级高于 class,品牌色在其上精确覆盖。
// 组件经 stylex.create 引用 tokens.['--xid-*'](编译为 var(--xid-*)),无需感知主题来源。
// 首帧(bundle 加载前)的底色与 color-scheme 由 index.html 内联兜底,挂载后由此处接管。

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { darkTheme } from '../styles/tokens.stylex'
import { BRAND_LOGO_TRANSPARENT } from './brand-assets'

// 主题模式:跟随系统(system)或强制 light/dark。
export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]
type ResolvedScheme = 'light' | 'dark'

// 单一配色方案下的色板(light 与 dark 各一份)。
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

// per-tenant / per-org 品牌配置(背景图/logo 由页面层用,变量层只管色与排版尺度)。
export type BrandConfig = {
  light: BrandPalette
  dark: BrandPalette
  // border-radius 基准(如 '0.5rem');font 为 CSS font-family 串。
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
  // 与 tokens.stylex.ts 的 --xid-font 保持同值(Inter Variable 在 main.tsx 注入)。
  fontFamily:
    '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  logoUrl: BRAND_LOGO_TRANSPARENT,
  appName: 'XID',
}

// 把单份 palette + 尺度展开为 CSS 变量映射(运行时 inline override,命中 StyleX 生成的 --xid-* 名)。
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

// 判断当前 brand 是否就是内置默认(默认时不做 inline override,让 StyleX tokens/darkTheme 自然生效)。
function isDefaultBrand(brand: BrandConfig): boolean {
  return brand === DEFAULT_BRAND
}

function prefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

// darkTheme 编译产物 className(可能含多个空格分隔的 class),挂/卸 documentElement 用。
const DARK_THEME_CLASSES = (stylex.props(darkTheme).className ?? '').split(' ').filter(Boolean)

// 移动端浏览器框色,与 tokens 的 --xid-bg(light/dark)对应;index.html 首帧兜底用同值。
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
  // 初始 brand(默认内置)。运行时拉到租户/org 品牌后用 setBrand 覆盖。
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

  // 跟随系统配色变化(仅 mode=system 时影响,但监听始终挂着以保持 systemDark 准确)。
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

  // 主题统一应用在 documentElement:darkTheme class 翻转全部 token,
  // color-scheme 让原生 UI(滚动条/表单控件/自动填充)跟随,theme-color 让移动端浏览器框跟随。
  // 自定义品牌再以 inline 变量覆盖品牌色;默认 brand 时清空 inline 让 tokens/darkTheme 接管。
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

// 供测试 / 服务端预渲染直接取变量映射(纯函数,无副作用)。
export function brandToCssVars(brand: BrandConfig, scheme: ResolvedScheme): Record<string, string> {
  return paletteToVars(brand, scheme)
}
