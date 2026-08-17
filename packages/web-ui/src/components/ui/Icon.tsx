// 内部线性图标:24x24 viewBox、1.5 stroke、round caps,颜色一律 currentColor 继承上下文。
// 不引第三方图标库,避免包体与风格漂移;新增图标先在此登记 name 再使用。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'

export const ICON_NAMES = [
  'gauge',
  'folder',
  'users',
  'user-circle',
  'key',
  'fingerprint',
  'shield-check',
  'seal-check',
  'globe',
  'palette',
  'webhook',
  'gear',
  'building',
  'scroll',
  'plug',
  'arrows-left-right',
  'megaphone',
  'package',
  'squares-four',
  'flag',
  'credit-card',
  'list-status',
  'book',
  'caret-down',
  'check',
  'sign-out',
  'arrow-right',
  'arrow-left',
  'arrow-up-right',
] as const

export type IconName = (typeof ICON_NAMES)[number]

const glyphs: Record<IconName, ReactNode> = {
  gauge: (
    <>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="m12 15 3.5-4.5" />
    </>
  ),
  folder: (
    <path d="M3.75 17.25v-10.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2.25 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5Z" />
  ),
  users: (
    <>
      <circle cx="9.25" cy="8.75" r="3.5" />
      <path d="M3.25 19.25a6 6 0 0 1 12 0" />
      <path d="M15.75 5.45a3.5 3.5 0 0 1 0 6.6" />
      <path d="M17.25 13.4a6 6 0 0 1 3.5 5.85" />
    </>
  ),
  'user-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="9.75" r="3" />
      <path d="M6.2 18.6a5.8 5.8 0 0 1 11.6 0" />
    </>
  ),
  key: (
    <>
      <circle cx="8.25" cy="15.75" r="4.5" />
      <path d="m11.55 12.45 8.7-8.7" />
      <path d="m16.5 7.5 2.25 2.25" />
      <path d="m14.25 9.75 1.5 1.5" />
    </>
  ),
  fingerprint: (
    <>
      <path d="M6.6 6.9a8 8 0 0 1 10.8 0" />
      <path d="M4.4 12.2a8 8 0 0 0 .7 3" />
      <path d="M19.4 15.2a8 8 0 0 0 .2-3.2 7.8 7.8 0 0 0-.9-3.4" />
      <path d="M8.4 18.4a5.6 5.6 0 0 1-.9-3.1v-.3a4.5 4.5 0 0 1 9 0c0 1.9.4 3.4 1.1 4.5" />
      <path d="M12 11.5a3.5 3.5 0 0 1 3.5 3.5c0 1.7.3 3.2.9 4.5" />
      <path d="M12 14.5v.5c0 2.4.5 4.5 1.4 6.2" />
    </>
  ),
  'shield-check': (
    <>
      <path d="M12 2.75 4.75 5.5v5.75c0 4.65 3.05 8.05 7.25 10 4.2-1.95 7.25-5.35 7.25-10V5.5Z" />
      <path d="m8.75 11.75 2.5 2.5 4-4.75" />
    </>
  ),
  'seal-check': (
    <>
      <circle cx="12" cy="10" r="6" />
      <path d="m9.25 10 2 2 3.5-4" />
      <path d="m8.75 15.1-1.25 5.65 4.5-2.5 4.5 2.5-1.25-5.65" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M3.75 12h16.5" />
      <path d="M12 3.75c2.4 2.25 3.6 5.1 3.6 8.25s-1.2 6-3.6 8.25c-2.4-2.25-3.6-5.1-3.6-8.25s1.2-6 3.6-8.25Z" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.5 0 2.4-1 2.4-2.2 0-1.5-1.2-1.9-1.2-3.2 0-1.2 1-2.1 2.3-2.1h2.4a2.9 2.9 0 0 0 2.9-2.9C20.8 6.3 16.9 3.5 12 3.5Z" />
      <circle cx="7.5" cy="10.5" r="1.1" />
      <circle cx="10.5" cy="7.5" r="1.1" />
      <circle cx="14.5" cy="7.25" r="1.1" />
    </>
  ),
  webhook: (
    <>
      <path d="M10.3 5.65a3.5 3.5 0 1 1 5.55 2.85" />
      <path d="m15.4 11.2 3.55 6.15a3.5 3.5 0 1 1-3.03 1.75" />
      <path d="M9.5 15.4H5.9a3.5 3.5 0 1 1 1.75-6.45" />
      <circle cx="12" cy="13" r="1.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 3v2.25M12 18.75V21M3 12h2.25M18.75 12H21M5.64 5.64l1.6 1.6M16.76 16.76l1.6 1.6M18.36 5.64l-1.6 1.6M7.24 16.76l-1.6 1.6" />
    </>
  ),
  building: (
    <>
      <path d="M3.75 20.25h16.5" />
      <path d="M6 20.25V5.25A1.5 1.5 0 0 1 7.5 3.75h6A1.5 1.5 0 0 1 15 5.25v15" />
      <path d="M15 9h3a1.5 1.5 0 0 1 1.5 1.5v9.75" />
      <path d="M8.75 7.25h3.5M8.75 10.75h3.5M8.75 14.25h3.5" />
    </>
  ),
  scroll: (
    <>
      <path d="M4.5 17.75a2.5 2.5 0 0 0 2.5 2.5h10.5a2.5 2.5 0 0 0 2.5-2.5v-1.5h-4.75" />
      <path d="M15.25 16.25v1.5a2.5 2.5 0 0 1-2.5 2.5" />
      <path d="M15.25 16.25V6.25a2.5 2.5 0 0 1 2.5-2.5H7a2.5 2.5 0 0 0-2.5 2.5v11.5" />
      <path d="M8 8h4.5M8 11.5h4.5" />
    </>
  ),
  plug: (
    <>
      <path d="M9.25 3.25v4M14.75 3.25v4" />
      <path d="M6.75 7.25h10.5v3.5a5.25 5.25 0 0 1-10.5 0Z" />
      <path d="M12 16v4.75" />
    </>
  ),
  'arrows-left-right': (
    <>
      <path d="M4 8.5h13.25" />
      <path d="m14.25 5.5 3 3-3 3" />
      <path d="M20 15.5H6.75" />
      <path d="m9.75 12.5-3 3 3 3" />
    </>
  ),
  megaphone: (
    <>
      <path d="M19.5 5v14l-10.5-3.8H5a1.5 1.5 0 0 1-1.5-1.5v-3.4A1.5 1.5 0 0 1 5 8.8h4Z" />
      <path d="M8.5 15.2v3a2.25 2.25 0 0 0 4.5.6" />
    </>
  ),
  package: (
    <>
      <path d="m12 3 8 3.9v10.2L12 21l-8-3.9V6.9Z" />
      <path d="m4 6.9 8 3.9 8-3.9" />
      <path d="M12 10.8V21" />
      <path d="m8 4.95 8 3.9" />
    </>
  ),
  'squares-four': (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  flag: (
    <>
      <path d="M5.25 21V4" />
      <path d="M5.25 4.75c2.75-1.5 5.5 1.25 8.25 0s5-.75 6.75.5v8.5c-1.75-1.25-4-1.75-6.75-.5s-5.5-1.5-8.25 0" />
    </>
  ),
  'credit-card': (
    <>
      <rect x="3" y="5.25" width="18" height="13.5" rx="1.5" />
      <path d="M3 9.75h18" />
      <path d="M6.5 14.25h4.5" />
    </>
  ),
  'list-status': (
    <>
      <path d="M4 6.25h16" />
      <path d="M4 11.25h9.5" />
      <path d="M4 16.25h7" />
      <path d="m14.75 15.75 1.75 1.75 3.5-3.75" />
    </>
  ),
  book: (
    <>
      <path d="M4.5 19.5A2.25 2.25 0 0 1 6.75 17.25H20" />
      <path d="M6.75 2.5H20v20H6.75A2.25 2.25 0 0 1 4.5 19.5v-15A2.25 2.25 0 0 1 6.75 2.5Z" />
    </>
  ),
  'caret-down': <path d="m6.75 9.75 5.25 5.25 5.25-5.25" />,
  check: <path d="m4.75 12.75 4.75 4.75L19.25 7.25" />,
  'sign-out': (
    <>
      <path d="M14.75 8V6.25a2 2 0 0 0-2-2h-6.5a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2h6.5a2 2 0 0 0 2-2V16" />
      <path d="M9.5 12h11" />
      <path d="m17 8.5 3.5 3.5-3.5 3.5" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M3.75 12h16.5" />
      <path d="m14 5.75 6.25 6.25L14 18.25" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M20.25 12H3.75" />
      <path d="M10 5.75 3.75 12 10 18.25" />
    </>
  ),
  'arrow-up-right': (
    <>
      <path d="M6.75 17.25 17.25 6.75" />
      <path d="M8.25 6.75h9v9" />
    </>
  ),
}

const styles = stylex.create({
  root: {
    display: 'inline-block',
    flexShrink: 0,
    verticalAlign: 'middle',
  },
})

export type IconProps = {
  name: IconName
  size?: number
  // 缺省视为装饰图标(aria-hidden);有独立语义时给 label。
  label?: string
}

export function Icon({ name, size = 16, label }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      {...stylex.props(styles.root)}
    >
      {label ? <title>{label}</title> : null}
      {glyphs[name]}
    </svg>
  )
}
