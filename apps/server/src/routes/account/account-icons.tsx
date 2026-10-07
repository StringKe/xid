// 账户门户专用线性图标:24x24、1.6 描边、currentColor;只给一级导航与设备类型。

import type { ReactNode } from 'react'

const GLYPHS = {
  profile: (
    <>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20c.9-3.6 3.9-5.6 7.5-5.6s6.6 2 7.5 5.6" />
    </>
  ),
  security: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h8.5M17.5 12v3M20.5 12v2.5" />
    </>
  ),
  devices: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2.5 19h19" />
    </>
  ),
  organizations: (
    <path d="M4.5 20V5.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V20M13.5 9.5h5a1 1 0 0 1 1 1V20M3 20h18M8 8.5h2M8 12h2M8 15.5h2" />
  ),
  privacy: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
  tablet: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
  securityKey: (
    <>
      <rect x="8" y="9" width="8" height="12" rx="2" />
      <path d="M10 9V4.5h4V9M12 13v2.5" />
    </>
  ),
  impersonation: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.7-3 2.9-4.7 5.5-4.7s4.8 1.7 5.5 4.7M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.6c1.6.6 2.6 2.1 3 4.4" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
  printer: (
    <>
      <path d="M7 8.5V4h10v4.5M7 17H5a1.5 1.5 0 0 1-1.5-1.5v-5.5A1.5 1.5 0 0 1 5 8.5h14a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 19 17h-2" />
      <rect x="7" y="13.5" width="10" height="6.5" rx="1" />
    </>
  ),
  app: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 12h6" />
    </>
  ),
} as const

export type AccountIconName = keyof typeof GLYPHS

export function AccountIcon({
  name,
  size = 16,
}: {
  name: AccountIconName
  size?: number
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}
