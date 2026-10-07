import type { ReactNode } from 'react'

export const AUTH_ICON_NAMES = [
  'mail',
  'smartphone',
  'message',
  'link',
  'password',
  'passkey',
  'file-text',
  'download',
  'printer',
  'clock',
  'monitor',
  'refresh',
  'scan-face',
  'cloud',
  'user',
] as const

export type AuthIconName = (typeof AUTH_ICON_NAMES)[number]

export const authGlyphs: Record<AuthIconName, ReactNode> = {
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  smartphone: (
    <>
      <rect x="6.5" y="3" width="11" height="18" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
  message: (
    <path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  password: (
    <>
      <rect x="3" y="7.5" width="18" height="9" rx="2" />
      <path d="M7.5 12h.01M10.5 12h.01M13.5 12h.01M16.5 12h.01" />
    </>
  ),
  passkey: (
    <>
      <circle cx="8.5" cy="12" r="3.5" />
      <path d="M12 12h8.5M17.5 12v3M20.5 12v2" />
    </>
  ),
  'file-text': (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 11 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  printer: (
    <>
      <path d="M7 9V4.5h10V9" />
      <rect x="4" y="9" width="16" height="7.5" rx="1.5" />
      <path d="M7 14h10v5.5H7Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  monitor: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  'scan-face': (
    <>
      <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5" />
      <path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0" />
    </>
  ),
  cloud: <path d="M7.5 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 11.1 3.75 3.75 0 0 0 7.5 18.5Z" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </>
  ),
}
