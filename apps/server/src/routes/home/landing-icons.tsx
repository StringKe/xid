// landing 内联线性图标:'|' 分隔的多段 path,stroke 继承 currentColor。
// 不引图标库(bundle 体积),路径取自设计稿原型。

import type { ReactNode } from 'react'

export const ICON_PATHS = {
  sun: 'M12 3v2|M12 19v2|M5.6 5.6l1.4 1.4|M17 17l1.4 1.4|M3 12h2|M19 12h2|M5.6 18.4l1.4-1.4|M17 7l1.4-1.4|M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  menu: 'M4 7h16|M4 12h16|M4 17h16',
  close: 'M18 6 6 18|M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  replay: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5',
  copy: 'M8 8h12v12H8z|M16 8V4H4v12h4',
} as const

export type IconName = keyof typeof ICON_PATHS

type IconProps = {
  name: IconName
  size?: number
  strokeWidth?: number
}

export function Icon({ name, size = 18, strokeWidth = 2 }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name].split('|').map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
