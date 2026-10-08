import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ImageMetadata } from 'astro'

// 真实产品截图:本地三 Worker 栈 + Northwind Logistics 演示租户,deviceScaleFactor 2,按 08 画板的产品框裁切。
// width/height 是文件像素,按一半排版。

export const PRODUCT_SHOT_SCALE = 2

export const productShotAlt = {
  consoleUsers: msg`XID console users list for Northwind Logistics, with sign-in methods and organizations per user`,
  hostedSignIn: msg`Hosted sign-in page for Northwind Logistics, continuing to the Fleet Planner app`,
  accountDevices: msg`Account devices page where a user sees and signs out their sessions`,
  enterpriseSso: msg`Inbound SSO connections in the XID console with an active Okta SAML connection`,
  directorySync: msg`Directory sync in the XID console with an active Okta SCIM directory, its user and group counts and last sync`,
  scopeSwitcher: msg`Organization switcher in the XID console listing the organizations and projects the admin manages`,
  metrics: msg`Key metrics in the XID console overview: daily and monthly active users`,
} as const satisfies Record<string, MessageDescriptor>

export type ProductShotFrame = keyof typeof productShotAlt
export type ProductShotTheme = 'light' | 'dark'
export type ProductShotLocale = 'en' | 'zh-Hans'

export type ProductShot = {
  frame: ProductShotFrame
  file: string
  viewport: number
  width: number
  height: number
  theme: ProductShotTheme
  locale: ProductShotLocale
  alt: MessageDescriptor
  src: ImageMetadata
}

type ShotEntry = readonly [
  file: string,
  frame: ProductShotFrame,
  viewport: number,
  width: number,
  height: number,
]

const ENTRIES: readonly ShotEntry[] = [
  ['console-users-1440-light-en', 'consoleUsers', 1440, 1244, 796],
  ['console-users-1440-dark-en', 'consoleUsers', 1440, 1244, 796],
  ['console-users-1440-light-zh-Hans', 'consoleUsers', 1440, 1244, 796],
  ['console-users-1440-dark-zh-Hans', 'consoleUsers', 1440, 1244, 796],
  ['hosted-signin-350-light-en', 'hostedSignIn', 350, 700, 784],
  ['hosted-signin-350-dark-en', 'hostedSignIn', 350, 700, 784],
  ['hosted-signin-350-light-zh-Hans', 'hostedSignIn', 350, 700, 748],
  ['hosted-signin-350-dark-zh-Hans', 'hostedSignIn', 350, 700, 748],
  ['hosted-signin-356-light-en', 'hostedSignIn', 356, 712, 748],
  ['hosted-signin-356-dark-en', 'hostedSignIn', 356, 712, 748],
  ['hosted-signin-356-light-zh-Hans', 'hostedSignIn', 356, 712, 748],
  ['hosted-signin-356-dark-zh-Hans', 'hostedSignIn', 356, 712, 748],
  ['account-devices-1150-light-en', 'accountDevices', 1150, 2300, 1172],
  ['account-devices-1150-dark-en', 'accountDevices', 1150, 2300, 1172],
  ['account-devices-356-light-en', 'accountDevices', 356, 712, 1666],
  ['account-devices-356-dark-en', 'accountDevices', 356, 712, 1666],
  ['console-enterprise-sso-842-light-en', 'enterpriseSso', 842, 1684, 650],
  ['console-enterprise-sso-842-dark-en', 'enterpriseSso', 842, 1684, 650],
  ['console-directory-sync-694-light-en', 'directorySync', 694, 1388, 544],
  ['console-directory-sync-694-dark-en', 'directorySync', 694, 1388, 544],
  ['console-directory-sync-356-light-en', 'directorySync', 356, 712, 1222],
  ['console-directory-sync-356-dark-en', 'directorySync', 356, 712, 1222],
  ['console-scope-switcher-1320-light-en', 'scopeSwitcher', 1320, 1292, 810],
  ['console-scope-switcher-1320-dark-en', 'scopeSwitcher', 1320, 1292, 810],
  ['console-scope-switcher-356-light-en', 'scopeSwitcher', 356, 712, 708],
  ['console-scope-switcher-356-dark-en', 'scopeSwitcher', 356, 712, 708],
  ['console-metrics-766-light-en', 'metrics', 766, 1532, 300],
  ['console-metrics-766-dark-en', 'metrics', 766, 1532, 300],
]

const images = import.meta.glob<ImageMetadata>('../assets/product/*.webp', {
  eager: true,
  import: 'default',
})

function imageFor(file: string): ImageMetadata {
  const image = images[`../assets/product/${file}.webp`]
  if (!image) throw new Error(`Missing product shot ${file}.webp`)
  return image
}

export const productShots: readonly ProductShot[] = ENTRIES.map(
  ([file, frame, viewport, width, height]) => ({
    frame,
    file,
    viewport,
    width,
    height,
    theme: file.includes('-dark-') ? 'dark' : 'light',
    locale: file.endsWith('-zh-Hans') ? 'zh-Hans' : 'en',
    alt: productShotAlt[frame],
    src: imageFor(file),
  }),
)

// 只有首页 hero 一对有 zh-Hans 截图,其余语言回落到 en。
export function productShot(
  frame: ProductShotFrame,
  options: { viewport: number; theme: ProductShotTheme; locale: string },
): ProductShot {
  const candidates = productShots.filter(
    (shot) =>
      shot.frame === frame && shot.viewport === options.viewport && shot.theme === options.theme,
  )
  const shot =
    candidates.find((candidate) => candidate.locale === options.locale) ??
    candidates.find((candidate) => candidate.locale === 'en')
  if (!shot)
    throw new Error(`No product shot for ${frame} at ${options.viewport}px (${options.theme})`)
  return shot
}
