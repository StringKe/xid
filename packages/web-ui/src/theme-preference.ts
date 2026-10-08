// 主题偏好:三端同一键 xid.theme(system | light | dark),缺省跟随系统。不依赖 React,静态站构建期也可引用。
// 首帧脚本(apps/server/index.html、apps/console/index.html、站点 BaseLayout)按同一规则写 data-theme,改这里要同步改它们。

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]
export type ThemeScheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'xid.theme'

// 与 tokens --xid-bg 对应,写入 <meta name="theme-color">。
export const THEME_COLOR: Record<ThemeScheme, string> = { light: '#ffffff', dark: '#181818' }

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

export function readThemeMode(): ThemeMode {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    return isThemeMode(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function persistThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') globalThis.localStorage?.removeItem(THEME_STORAGE_KEY)
    else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // 隐私模式等 localStorage 不可用时静默,主题仍生效本会话。
  }
}

export function resolveThemeScheme(mode: ThemeMode, systemDark: boolean): ThemeScheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}
