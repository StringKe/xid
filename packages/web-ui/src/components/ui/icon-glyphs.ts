// 图标字形纯数据,不依赖 React,Astro 静态站与产品端 Icon 读同一份。
// 24x24 viewBox、1.6 stroke、round caps,颜色一律 currentColor;新增图标先在分组文件登记 name。

import { AUTH_ICON_NAMES, authGlyphs } from './icon-auth-glyphs'
import { INTERFACE_ICON_NAMES, interfaceGlyphs } from './icon-interface-glyphs'
import { NAV_ICON_NAMES, navGlyphs } from './icon-nav-glyphs'

export type IconShape =
  | readonly ['path', { readonly d: string }]
  | readonly ['circle', { readonly cx: string; readonly cy: string; readonly r: string }]
  | readonly [
      'rect',
      {
        readonly x: string
        readonly y: string
        readonly width: string
        readonly height: string
        readonly rx: string
      },
    ]

export const ICON_NAMES = [...NAV_ICON_NAMES, ...INTERFACE_ICON_NAMES, ...AUTH_ICON_NAMES] as const

export type IconName = (typeof ICON_NAMES)[number]

export const ICON_GLYPHS: Record<IconName, readonly IconShape[]> = {
  ...navGlyphs,
  ...interfaceGlyphs,
  ...authGlyphs,
}

export const ICON_FRAME = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const
