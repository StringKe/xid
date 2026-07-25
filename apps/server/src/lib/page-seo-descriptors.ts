// 自动生成:node apps/server/scripts/sync-page-seo-descriptors.mjs
// 页面级 SEO MessageDescriptor(无 macro,供测试与 SSR 直引)。源文案在 page-seo-messages.ts。

import type { MessageDescriptor } from '@lingui/core'

function seoDescriptor(id: string, message: string): MessageDescriptor {
  return { id, message }
}

export const seoHomeTitle = seoDescriptor('Qpj05B', `XID | Edge identity platform`)
export const seoHomeDescription = seoDescriptor(
  'bCvFvL',
  `XID is an edge-native identity platform for OIDC, OAuth, organization RBAC, enterprise SSO, SCIM, passkeys, and networkless JWT verification on Cloudflare.`,
)
export const seoDocsHubTitle = seoDescriptor('vpjfgc', `Developer docs | XID`)
export const seoDocsHubDescription = seoDescriptor(
  'EO7n9V',
  `Technical documentation for OIDC, Hosted Auth, enterprise SSO, SCIM, SAML, Management API, webhooks, branding, and SDK integration on XID.`,
)
export const seoNotFoundTitle = seoDescriptor('iUkekb', `Page not found | XID`)
export const seoSignInTitle = seoDescriptor('bip6wX', `Sign in | XID`)
export const seoSignUpTitle = seoDescriptor('tq4FUn', `Sign up | XID`)
export const seoForgotPasswordTitle = seoDescriptor('gDD4V6', `Reset password | XID`)
export const seoMfaTitle = seoDescriptor('IATXQ-', `Two-factor authentication | XID`)
export const seoVerifyEmailTitle = seoDescriptor('Hpiwvx', `Verify email | XID`)
export const seoAcceptInvitationTitle = seoDescriptor('vNPiA5', `Accept invitation | XID`)
export const seoCreateOrganizationTitle = seoDescriptor('DanXHh', `Create organization | XID`)
export const seoSelectOrganizationTitle = seoDescriptor('t0KHdN', `Select organization | XID`)
export const seoConsentTitle = seoDescriptor('q8lhVH', `Authorize application | XID`)
export const seoActivateDeviceTitle = seoDescriptor('HOIhuG', `Activate device | XID`)
export const seoCibaActivationTitle = seoDescriptor('-BSfoU', `Approve sign-in request | XID`)
export const seoAccountProfileTitle = seoDescriptor('Y7fB1U', `Profile | Account | XID`)
export const seoAccountSecurityTitle = seoDescriptor('9J1wG-', `Security | Account | XID`)
export const seoAccountConnectionsTitle = seoDescriptor('G5t79H', `Connections | Account | XID`)
export const seoAccountSessionsTitle = seoDescriptor('sMvepx', `Sessions | Account | XID`)
export const seoAccountDevicesTitle = seoDescriptor('VDEOYV', `Trusted devices | Account | XID`)
export const seoConsoleOverviewTitle = seoDescriptor('kjo2do', `Console overview | XID`)
export const seoConsoleUsersTitle = seoDescriptor('q4CxF4', `Users | Console | XID`)
export const seoConsoleOrganizationsTitle = seoDescriptor('ZlJXTl', `Organizations | Console | XID`)
export const seoConsoleSessionsTitle = seoDescriptor('EnOYHr', `Sessions | Console | XID`)
export const seoConsoleSecurityTitle = seoDescriptor('ochj2T', `Security | Console | XID`)
export const seoConsoleSettingsTitle = seoDescriptor('0QsJ5l', `Settings | Console | XID`)
export const seoOrgOverviewTitle = seoDescriptor('y-pBk0', `Organization overview | Console | XID`)
export const seoOrgMembersTitle = seoDescriptor('lUBUZG', `Members | Console | XID`)
export const seoOrgRolesTitle = seoDescriptor('3CjwFT', `Roles | Console | XID`)
export const seoOrgAuthPolicyTitle = seoDescriptor('6Fss-s', `Auth policy | Console | XID`)
export const seoOrgDeliveryChannelsTitle = seoDescriptor(
  'XVhIDa',
  `Delivery channels | Console | XID`,
)
export const seoOrgSocialProvidersTitle = seoDescriptor(
  '-sjyu1',
  `Social providers | Console | XID`,
)
export const seoOrgInboundSsoTitle = seoDescriptor(
  'gUsPa_',
  `Inbound enterprise SSO | Console | XID`,
)
export const seoOrgOutboundSsoTitle = seoDescriptor(
  'WDJu9v',
  `Outbound enterprise SSO | Console | XID`,
)
export const seoOrgScimTitle = seoDescriptor('UB_mLd', `Directory sync | Console | XID`)
export const seoOrgScimTargetsTitle = seoDescriptor('vhGFye', `SCIM targets | Console | XID`)
export const seoOrgDomainsTitle = seoDescriptor('8F9YFg', `Domains | Console | XID`)
export const seoOrgBrandingTitle = seoDescriptor('kFEuyM', `Branding | Console | XID`)
export const seoOrgApplicationsTitle = seoDescriptor('zE6GZ8', `OAuth applications | Console | XID`)
export const seoOrgWebhooksTitle = seoDescriptor('0-WDPk', `Webhooks | Console | XID`)
export const seoOrgApiKeysTitle = seoDescriptor('6mxmcc', `API keys | Console | XID`)
export const seoOrgAuditEventsTitle = seoDescriptor('7u-mRS', `Audit events | Console | XID`)
export const seoPlatformOverviewTitle = seoDescriptor('1VwcCx', `Platform overview | Console | XID`)
export const seoPlatformOrganizationsTitle = seoDescriptor(
  'Qesqz6',
  `Platform organizations | Console | XID`,
)
export const seoPlatformUsersTitle = seoDescriptor('TFOSQi', `Platform users | Console | XID`)
export const seoPlatformEventsTitle = seoDescriptor('m_6zdm', `Event stream | Console | XID`)
export const seoPlatformFlagsTitle = seoDescriptor('u1fW7C', `Feature flags | Console | XID`)
export const seoPlatformBillingTitle = seoDescriptor('pJMmXv', `Billing overview | Console | XID`)
export const seoPlatformSettingsTitle = seoDescriptor('848QWZ', `Platform settings | Console | XID`)

const DOC_DESCRIPTION_BY_SLUG: Record<string, MessageDescriptor> = {
  'getting-started': seoDescriptor(
    '6O6Qeu',
    `Connect an application to XID with OIDC discovery and Hosted Auth.`,
  ),
  'hosted-auth': seoDescriptor('CdVc1s', `Configure the unified sign-in and user creation flow.`),
  'oidc-oauth': seoDescriptor(
    'QGJIeW',
    `Discovery, authorization, token, logout, and OAuth extension endpoints.`,
  ),
  'enterprise-sso': seoDescriptor(
    'nFqhLB',
    `Configure upstream enterprise IdPs and track downstream SaaS SSO boundaries.`,
  ),
  'social-login': seoDescriptor(
    'vyA64E',
    `Configure social OAuth providers with clear production support boundaries.`,
  ),
  'management-api': seoDescriptor(
    'peYEhy',
    `Use scoped API keys to manage organization resources from your backend.`,
  ),
  webhooks: seoDescriptor(
    'dc4vFf',
    `Subscribe to XID events and receive signed HTTP payloads for user and org changes.`,
  ),
  branding: seoDescriptor(
    'mmWlpC',
    `Customize Hosted Auth with colors, fonts, radius, logos, and custom CSS.`,
  ),
  scim: seoDescriptor(
    'TxjA3g',
    `SCIM 2.0 endpoint contract for provisioning users and groups into XID.`,
  ),
  saml: seoDescriptor('eNUpzQ', `Connect enterprise identity providers using SAML 2.0.`),
  sdks: seoDescriptor(
    'g6oUl1',
    `TypeScript packages and locally verified native SDKs for server, web, mobile, and desktop.`,
  ),
  'sdks/core': seoDescriptor(
    'cCZ8QF',
    `Browser SDK for session state, tokens, and XID API calls in web apps.`,
  ),
  'sdks/backend': seoDescriptor(
    'ixXSaR',
    `Server SDK for networkless JWT verification on Cloudflare Workers and Node.`,
  ),
  'sdks/react': seoDescriptor(
    'HhBBrz',
    `React bindings for XID session state, hooks, and hosted UI components.`,
  ),
  'sdks/nextjs': seoDescriptor(
    'wAsI0G',
    `Next.js helpers for XID authentication in App Router and middleware.`,
  ),
  'self-hosting': seoDescriptor(
    'k_gMnM',
    `Run XID on your own Cloudflare account with Workers, D1, KV, R2, and Durable Objects.`,
  ),
}

export function docSeoDescriptionForSlug(slug: string): MessageDescriptor | null {
  return DOC_DESCRIPTION_BY_SLUG[slug] ?? null
}

const DOC_TITLE_BY_SLUG: Record<string, MessageDescriptor> = {
  'getting-started': seoDescriptor('fmBoBz', `Getting started | XID Docs`),
  'hosted-auth': seoDescriptor('aY6oul', `Hosted Auth | XID Docs`),
  'oidc-oauth': seoDescriptor('8PbkQi', `OIDC and OAuth | XID Docs`),
  'enterprise-sso': seoDescriptor('iBPbs7', `Enterprise SSO | XID Docs`),
  'social-login': seoDescriptor('X0D0zY', `Social login | XID Docs`),
  'management-api': seoDescriptor('gojpMk', `Management API | XID Docs`),
  webhooks: seoDescriptor('5NkEZJ', `Webhooks | XID Docs`),
  branding: seoDescriptor('M_YBq1', `Branding | XID Docs`),
  scim: seoDescriptor('ga_GZE', `SCIM | XID Docs`),
  saml: seoDescriptor('C7VMiQ', `SAML | XID Docs`),
  sdks: seoDescriptor('uVpkHN', `SDKs | XID Docs`),
  'sdks/core': seoDescriptor('5m_3Eq', `@xid-kit/core | XID Docs`),
  'sdks/backend': seoDescriptor('akJk7O', `@xid-kit/backend | XID Docs`),
  'sdks/react': seoDescriptor('ETvjuZ', `@xid-kit/react | XID Docs`),
  'sdks/nextjs': seoDescriptor('LereDO', `@xid-kit/nextjs | XID Docs`),
  'sdks/react-native': seoDescriptor('qzJ0iD', `React Native SDK | XID Docs`),
  'sdks/vue': seoDescriptor('HrW-YZ', `Vue SDK | XID Docs`),
  'sdks/nuxt': seoDescriptor('L0Wiwu', `Nuxt SDK | XID Docs`),
  'sdks/svelte': seoDescriptor('VvmCrT', `Svelte SDK | XID Docs`),
  'sdks/solid': seoDescriptor('72CELv', `Solid SDK | XID Docs`),
  'sdks/angular': seoDescriptor('VYGBgt', `Angular SDK | XID Docs`),
  'sdks/astro': seoDescriptor('Vwv96j', `Astro SDK | XID Docs`),
  'sdks/remix': seoDescriptor('DweYqJ', `Remix SDK | XID Docs`),
  'sdks/expo': seoDescriptor('cTy0gK', `Expo SDK | XID Docs`),
  'sdks/electron': seoDescriptor('lOhAa2', `Electron SDK | XID Docs`),
  'sdks/tauri': seoDescriptor('K1owVi', `Tauri SDK | XID Docs`),
  'sdks/go': seoDescriptor('6PXKWL', `Go SDK | XID Docs`),
  'sdks/rust': seoDescriptor('SobD0u', `Rust SDK | XID Docs`),
  'sdks/python': seoDescriptor('V4zIMa', `Python SDK | XID Docs`),
  'sdks/ruby': seoDescriptor('j5ZLG9', `Ruby SDK | XID Docs`),
  'sdks/php': seoDescriptor('KPNTtz', `PHP SDK | XID Docs`),
  'sdks/java': seoDescriptor('79iKFo', `Java SDK | XID Docs`),
  'sdks/dotnet': seoDescriptor('wJPJro', `.NET SDK | XID Docs`),
  'sdks/ios': seoDescriptor('tZGXB8', `iOS SDK | XID Docs`),
  'sdks/android': seoDescriptor('QSEcId', `Android SDK | XID Docs`),
  'sdks/flutter': seoDescriptor('sg_vfv', `Flutter SDK | XID Docs`),
  'sdks/macos': seoDescriptor('wMaHVW', `macOS SDK | XID Docs`),
  'sdks/windows': seoDescriptor('FAC6-3', `Windows SDK | XID Docs`),
  'sdks/linux': seoDescriptor('1SQgUn', `Linux SDK | XID Docs`),
  'self-hosting': seoDescriptor('UYkEyU', `Self-hosting | XID Docs`),
}

export function docSeoTitleForSlug(slug: string): MessageDescriptor | null {
  return DOC_TITLE_BY_SLUG[slug] ?? null
}
