// 页面级 SEO 文案(lingui msg)。RoutePageSeo 按路由解析后经 i18n._() 写入 document.title 与 meta。

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

export const seoHomeTitle = msg`XID | Edge identity platform`
export const seoHomeDescription = msg`XID is an edge-native identity platform for OIDC, OAuth, organization RBAC, enterprise SSO, SCIM, passkeys, and networkless JWT verification on Cloudflare.`

export const seoDocsHubTitle = msg`Developer docs | XID`
export const seoDocsHubDescription = msg`Technical documentation for OIDC, Hosted Auth, enterprise SSO, SCIM, SAML, Management API, webhooks, branding, and SDK integration on XID.`

export const seoNotFoundTitle = msg`Page not found | XID`

export const seoSignInTitle = msg`Sign in | XID`
export const seoSignUpTitle = msg`Sign up | XID`
export const seoForgotPasswordTitle = msg`Reset password | XID`
export const seoMfaTitle = msg`Two-factor authentication | XID`
export const seoVerifyEmailTitle = msg`Verify email | XID`
export const seoAcceptInvitationTitle = msg`Accept invitation | XID`
export const seoCreateOrganizationTitle = msg`Create organization | XID`
export const seoSelectOrganizationTitle = msg`Select organization | XID`
export const seoConsentTitle = msg`Authorize application | XID`
export const seoActivateDeviceTitle = msg`Activate device | XID`
export const seoCibaActivationTitle = msg`Approve sign-in request | XID`

export const seoAccountProfileTitle = msg`Profile | Account | XID`
export const seoAccountSecurityTitle = msg`Security | Account | XID`
export const seoAccountConnectionsTitle = msg`Connections | Account | XID`
export const seoAccountSessionsTitle = msg`Sessions | Account | XID`
export const seoAccountDevicesTitle = msg`Trusted devices | Account | XID`

export const seoConsoleOverviewTitle = msg`Console overview | XID`
export const seoConsoleUsersTitle = msg`Users | Console | XID`
export const seoConsoleOrganizationsTitle = msg`Organizations | Console | XID`
export const seoConsoleSessionsTitle = msg`Sessions | Console | XID`
export const seoConsoleSecurityTitle = msg`Security | Console | XID`
export const seoConsoleSettingsTitle = msg`Settings | Console | XID`

export const seoOrgOverviewTitle = msg`Organization overview | Console | XID`
export const seoOrgMembersTitle = msg`Members | Console | XID`
export const seoOrgRolesTitle = msg`Roles | Console | XID`
export const seoOrgAuthPolicyTitle = msg`Auth policy | Console | XID`
export const seoOrgDeliveryChannelsTitle = msg`Delivery channels | Console | XID`
export const seoOrgSocialProvidersTitle = msg`Social providers | Console | XID`
export const seoOrgInboundSsoTitle = msg`Inbound enterprise SSO | Console | XID`
export const seoOrgOutboundSsoTitle = msg`Outbound enterprise SSO | Console | XID`
export const seoOrgScimTitle = msg`Directory sync | Console | XID`
export const seoOrgScimTargetsTitle = msg`SCIM targets | Console | XID`
export const seoOrgDomainsTitle = msg`Domains | Console | XID`
export const seoOrgBrandingTitle = msg`Branding | Console | XID`
export const seoOrgApplicationsTitle = msg`OAuth applications | Console | XID`
export const seoOrgWebhooksTitle = msg`Webhooks | Console | XID`
export const seoOrgApiKeysTitle = msg`API keys | Console | XID`
export const seoOrgAuditEventsTitle = msg`Audit events | Console | XID`

export const seoPlatformOverviewTitle = msg`Platform overview | Console | XID`
export const seoPlatformOrganizationsTitle = msg`Platform organizations | Console | XID`
export const seoPlatformUsersTitle = msg`Platform users | Console | XID`
export const seoPlatformEventsTitle = msg`Event stream | Console | XID`
export const seoPlatformFlagsTitle = msg`Feature flags | Console | XID`
export const seoPlatformBillingTitle = msg`Billing overview | Console | XID`
export const seoPlatformSettingsTitle = msg`Platform settings | Console | XID`

const DOC_DESCRIPTION_BY_SLUG: Record<string, MessageDescriptor> = {
  'getting-started': msg`Connect an application to XID with OIDC discovery and Hosted Auth.`,
  'hosted-auth': msg`Configure the unified sign-in and user creation flow.`,
  'oidc-oauth': msg`Discovery, authorization, token, logout, and OAuth extension endpoints.`,
  'enterprise-sso': msg`Configure upstream enterprise IdPs and track downstream SaaS SSO boundaries.`,
  'social-login': msg`Configure social OAuth providers with clear production support boundaries.`,
  'management-api': msg`Use scoped API keys to manage organization resources from your backend.`,
  webhooks: msg`Subscribe to XID events and receive signed HTTP payloads for user and org changes.`,
  branding: msg`Customize Hosted Auth with colors, fonts, radius, logos, and custom CSS.`,
  scim: msg`SCIM 2.0 endpoint contract for provisioning users and groups into XID.`,
  saml: msg`Connect enterprise identity providers using SAML 2.0.`,
  sdks: msg`TypeScript packages and locally verified native SDKs for server, web, mobile, and desktop.`,
  'sdks/core': msg`Browser SDK for session state, tokens, and XID API calls in web apps.`,
  'sdks/backend': msg`Server SDK for networkless JWT verification on Cloudflare Workers and Node.`,
  'sdks/react': msg`React bindings for XID session state, hooks, and hosted UI components.`,
  'sdks/nextjs': msg`Next.js helpers for XID authentication in App Router and middleware.`,
  'self-hosting': msg`Run XID on your own Cloudflare account with Workers, D1, KV, R2, and Durable Objects.`,
}

export function docSeoDescriptionForSlug(slug: string): MessageDescriptor | null {
  return DOC_DESCRIPTION_BY_SLUG[slug] ?? null
}

const DOC_TITLE_BY_SLUG: Record<string, MessageDescriptor> = {
  'getting-started': msg`Getting started | XID Docs`,
  'hosted-auth': msg`Hosted Auth | XID Docs`,
  'oidc-oauth': msg`OIDC and OAuth | XID Docs`,
  'enterprise-sso': msg`Enterprise SSO | XID Docs`,
  'social-login': msg`Social login | XID Docs`,
  'management-api': msg`Management API | XID Docs`,
  webhooks: msg`Webhooks | XID Docs`,
  branding: msg`Branding | XID Docs`,
  scim: msg`SCIM | XID Docs`,
  saml: msg`SAML | XID Docs`,
  sdks: msg`SDKs | XID Docs`,
  'sdks/core': msg`@xid-kit/core | XID Docs`,
  'sdks/backend': msg`@xid-kit/backend | XID Docs`,
  'sdks/react': msg`@xid-kit/react | XID Docs`,
  'sdks/nextjs': msg`@xid-kit/nextjs | XID Docs`,
  'sdks/react-native': msg`React Native SDK | XID Docs`,
  'sdks/vue': msg`Vue SDK | XID Docs`,
  'sdks/nuxt': msg`Nuxt SDK | XID Docs`,
  'sdks/svelte': msg`Svelte SDK | XID Docs`,
  'sdks/solid': msg`Solid SDK | XID Docs`,
  'sdks/angular': msg`Angular SDK | XID Docs`,
  'sdks/astro': msg`Astro SDK | XID Docs`,
  'sdks/remix': msg`Remix SDK | XID Docs`,
  'sdks/expo': msg`Expo SDK | XID Docs`,
  'sdks/electron': msg`Electron SDK | XID Docs`,
  'sdks/tauri': msg`Tauri SDK | XID Docs`,
  'sdks/go': msg`Go SDK | XID Docs`,
  'sdks/rust': msg`Rust SDK | XID Docs`,
  'sdks/python': msg`Python SDK | XID Docs`,
  'sdks/ruby': msg`Ruby SDK | XID Docs`,
  'sdks/php': msg`PHP SDK | XID Docs`,
  'sdks/java': msg`Java SDK | XID Docs`,
  'sdks/dotnet': msg`.NET SDK | XID Docs`,
  'sdks/ios': msg`iOS SDK | XID Docs`,
  'sdks/android': msg`Android SDK | XID Docs`,
  'sdks/flutter': msg`Flutter SDK | XID Docs`,
  'sdks/macos': msg`macOS SDK | XID Docs`,
  'sdks/windows': msg`Windows SDK | XID Docs`,
  'sdks/linux': msg`Linux SDK | XID Docs`,
  'self-hosting': msg`Self-hosting | XID Docs`,
}

export function docSeoTitleForSlug(slug: string): MessageDescriptor | null {
  return DOC_TITLE_BY_SLUG[slug] ?? null
}
