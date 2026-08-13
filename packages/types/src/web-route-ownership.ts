import { FRONTEND_WORKER_SERVICE_BINDING_NAMES } from './env.ts'

export const XID_APEX_HOST = 'xid.dev'
export const XID_WWW_HOST = 'www.xid.dev'

export const XID_SITE_LOCALES = ['zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const

export type XidSiteLocale = (typeof XID_SITE_LOCALES)[number]

export const XID_SITE_LOCALE_ROUTE_SEGMENTS = {
  'zh-Hans': 'zh-hans',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  'pt-BR': 'pt-br',
} as const satisfies Readonly<Record<XidSiteLocale, string>>

export const SITE_EXACT_PATHS = [
  '/',
  '/index.md',
  '/index.mdx',
  '/docs',
  '/docs/index.md',
  '/docs/index.mdx',
  '/status',
  '/status/',
  '/status/index.md',
  '/status/index.mdx',
  '/og.png',
  '/robots.txt',
  '/sitemap-index.xml',
  '/sitemap.xml',
  '/llms.txt',
  '/llms-full.txt',
  '/en/llms.txt',
  '/en/llms-full.txt',
  '/favicon.ico',
  '/favicon-16.png',
  '/favicon-32.png',
  '/favicon-48.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/site.webmanifest',
] as const

const SITE_PUBLIC_DOC_ROOTS = [
  'getting-started',
  'hosted-auth',
  'organizations',
  'oidc-oauth',
  'enterprise-sso',
  'social-login',
  'management-api',
  'webhooks',
  'branding',
  'scim',
  'saml',
  'sdks',
  'self-hosting',
] as const

export const SITE_PUBLIC_DOC_EXACT_PATHS = SITE_PUBLIC_DOC_ROOTS.filter(
  (root) => root !== 'scim',
).map((root) => `/${root}`)

export const SITE_PUBLIC_DOC_PREFIX_PATHS = SITE_PUBLIC_DOC_ROOTS.filter(
  (root) => root !== 'scim',
).map((root) => `/${root}/`)

export const SITE_SCIM_DOC_EXACT_PATHS = [
  '/scim',
  '/scim/',
  '/scim/index.md',
  '/scim/index.mdx',
] as const

export const SITE_PREFIX_PATHS = [
  '/docs/',
  '/_astro/',
  '/_nimbus/',
  '/pagefind/',
  '/og/',
  '/sitemap-',
  '/brand/',
  '/icons/',
  '/fonts/',
] as const

export const CONSOLE_EXACT_PATH = '/console'
export const CONSOLE_PREFIX_PATH = '/console/'
export const CORE_UI_ASSET_PREFIX = '/_core/'
export const WELL_KNOWN_LLMS_PATH = '/.well-known/llms.txt'

export const CORE_SPA_ROUTE_PATHS = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/magic-link',
  '/reset-password',
  '/verify-email',
  '/accept-invitation',
  '/create-organization',
  '/select-organization',
  '/mfa',
  '/consent',
  '/activate',
  '/ciba-activation',
  '/account',
  '/account/security',
  '/account/connections',
  '/account/sessions',
  '/account/devices',
] as const

const CORE_SPA_ROUTE_PATH_SET = new Set<string>(CORE_SPA_ROUTE_PATHS)

export function isCoreSpaRoute(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return CORE_SPA_ROUTE_PATH_SET.has(normalized)
}

export const CORE_RESERVED_EXACT_PATHS = [
  '/jwks',
  '/authorize',
  '/par',
  '/token',
  '/userinfo',
  '/end_session',
  '/check_session',
  '/backchannel_authentication',
  '/federation_registration',
  '/frontchannel_logout',
  '/gnap',
  '/uma',
  '/heart',
  '/oid4vp',
  '/oid4vci',
  '/introspect',
  '/revoke',
  '/device_authorization',
  '/register',
] as const

export const CORE_RESERVED_PREFIX_PATHS = [
  '/.well-known/',
  '/ssf/',
  '/caep/',
  '/risc/',
  '/gnap/',
  '/uma/',
  '/heart/',
  '/oid4vp/',
  '/oid4vci/',
  '/register/',
  '/auth/',
  '/sso/',
  '/scim/',
  '/v1/',
] as const

export type WebRouteOwner = 'site' | 'console' | 'core'
export type WebRouteHostMatcher =
  | { kind: 'exact'; hostname: string }
  | { kind: 'subdomain'; apexHostname: string }
  | { kind: 'xid-domain'; apexHostname: string }
export type WebRoutePathMatcher =
  | { kind: 'exact'; pathname: string }
  | { kind: 'prefix'; pathnamePrefix: string }
  | { kind: 'any' }
export type WebRouteBehavior = 'serve' | 'canonical-host-redirect' | 'well-known-llms-redirect'

export type WebRouteOwnershipRule = {
  id: string
  owner: WebRouteOwner
  priority: number
  host: WebRouteHostMatcher
  path: WebRoutePathMatcher
  behavior: WebRouteBehavior
}

const apexHost = { kind: 'exact', hostname: XID_APEX_HOST } as const
const wwwHost = { kind: 'exact', hostname: XID_WWW_HOST } as const
const tenantHost = { kind: 'subdomain', apexHostname: XID_APEX_HOST } as const
const xidDomain = { kind: 'xid-domain', apexHostname: XID_APEX_HOST } as const

const siteExactRules: WebRouteOwnershipRule[] = SITE_EXACT_PATHS.map((pathname) => ({
  id: `site:apex:exact:${pathname}`,
  owner: 'site',
  priority: 820,
  host: apexHost,
  path: { kind: 'exact', pathname },
  behavior: 'serve',
}))

const sitePrefixRules: WebRouteOwnershipRule[] = SITE_PREFIX_PATHS.map((pathnamePrefix) => ({
  id: `site:apex:prefix:${pathnamePrefix}`,
  owner: 'site',
  priority: 810,
  host: apexHost,
  path: { kind: 'prefix', pathnamePrefix },
  behavior: 'serve',
}))

const sitePublicDocExactRules: WebRouteOwnershipRule[] = SITE_PUBLIC_DOC_EXACT_PATHS.map(
  (pathname) => ({
    id: `site:apex:public-doc-exact:${pathname}`,
    owner: 'site',
    priority: 830,
    host: apexHost,
    path: { kind: 'exact', pathname },
    behavior: 'serve',
  }),
)

const sitePublicDocPrefixRules: WebRouteOwnershipRule[] = SITE_PUBLIC_DOC_PREFIX_PATHS.map(
  (pathnamePrefix) => ({
    id: `site:apex:public-doc-prefix:${pathnamePrefix}`,
    owner: 'site',
    priority: 825,
    host: apexHost,
    path: { kind: 'prefix', pathnamePrefix },
    behavior: 'serve',
  }),
)

const siteScimDocExactRules: WebRouteOwnershipRule[] = SITE_SCIM_DOC_EXACT_PATHS.map(
  (pathname) => ({
    id: `site:apex:scim-doc-exact:${pathname}`,
    owner: 'site',
    priority: 935,
    host: apexHost,
    path: { kind: 'exact', pathname },
    behavior: 'serve',
  }),
)

const siteLocaleRules: WebRouteOwnershipRule[] = XID_SITE_LOCALES.flatMap((locale) => {
  const routeSegment = XID_SITE_LOCALE_ROUTE_SEGMENTS[locale]
  return [
    {
      id: `site:apex:locale-exact:${locale}`,
      owner: 'site',
      priority: 805,
      host: apexHost,
      path: { kind: 'exact', pathname: `/${routeSegment}` },
      behavior: 'serve',
    },
    {
      id: `site:apex:locale-slash:${locale}`,
      owner: 'site',
      priority: 804,
      host: apexHost,
      path: { kind: 'exact', pathname: `/${routeSegment}/` },
      behavior: 'serve',
    },
    {
      id: `site:apex:locale-prefix:${locale}`,
      owner: 'site',
      priority: 800,
      host: apexHost,
      path: { kind: 'prefix', pathnamePrefix: `/${routeSegment}/` },
      behavior: 'serve',
    },
  ]
})

const coreReservedExactRules: WebRouteOwnershipRule[] = CORE_RESERVED_EXACT_PATHS.map(
  (pathname) => ({
    id: `core:reserved:exact:${pathname}`,
    owner: 'core',
    priority: 930,
    host: xidDomain,
    path: { kind: 'exact', pathname },
    behavior: 'serve',
  }),
)

const coreReservedPrefixRules: WebRouteOwnershipRule[] = CORE_RESERVED_PREFIX_PATHS.map(
  (pathnamePrefix) => ({
    id: `core:reserved:prefix:${pathnamePrefix}`,
    owner: 'core',
    priority: 920,
    host: xidDomain,
    path: { kind: 'prefix', pathnamePrefix },
    behavior: 'serve',
  }),
)

export const WEB_ROUTE_OWNERSHIP_RULES: readonly WebRouteOwnershipRule[] = [
  {
    id: 'site:www:override',
    owner: 'site',
    priority: 1000,
    host: wwwHost,
    path: { kind: 'any' },
    behavior: 'canonical-host-redirect',
  },
  ...siteScimDocExactRules,
  {
    id: 'core:well-known-llms',
    owner: 'core',
    priority: 950,
    host: xidDomain,
    path: { kind: 'exact', pathname: WELL_KNOWN_LLMS_PATH },
    behavior: 'well-known-llms-redirect',
  },
  {
    id: 'core:ui-assets',
    owner: 'core',
    priority: 940,
    host: xidDomain,
    path: { kind: 'prefix', pathnamePrefix: CORE_UI_ASSET_PREFIX },
    behavior: 'serve',
  },
  ...coreReservedExactRules,
  ...coreReservedPrefixRules,
  ...sitePublicDocExactRules,
  ...sitePublicDocPrefixRules,
  ...siteExactRules,
  ...sitePrefixRules,
  ...siteLocaleRules,
  {
    id: 'console:apex:exact',
    owner: 'console',
    priority: 720,
    host: apexHost,
    path: { kind: 'exact', pathname: CONSOLE_EXACT_PATH },
    behavior: 'serve',
  },
  {
    id: 'console:apex:prefix',
    owner: 'console',
    priority: 710,
    host: apexHost,
    path: { kind: 'prefix', pathnamePrefix: CONSOLE_PREFIX_PATH },
    behavior: 'serve',
  },
  {
    id: 'console:tenant:exact',
    owner: 'console',
    priority: 720,
    host: tenantHost,
    path: { kind: 'exact', pathname: CONSOLE_EXACT_PATH },
    behavior: 'serve',
  },
  {
    id: 'console:tenant:prefix',
    owner: 'console',
    priority: 710,
    host: tenantHost,
    path: { kind: 'prefix', pathnamePrefix: CONSOLE_PREFIX_PATH },
    behavior: 'serve',
  },
  {
    id: 'core:apex:fallback',
    owner: 'core',
    priority: 100,
    host: apexHost,
    path: { kind: 'any' },
    behavior: 'serve',
  },
  {
    id: 'core:tenant:fallback',
    owner: 'core',
    priority: 90,
    host: tenantHost,
    path: { kind: 'any' },
    behavior: 'serve',
  },
]

export type WebRouteOwnershipDecision = {
  url: string
  owner: WebRouteOwner | null
  matchedRuleId: string | null
  behavior: WebRouteBehavior | null
  redirectStatus: 308 | null
  redirectTarget: string | null
}

function matchesHost(hostname: string, matcher: WebRouteHostMatcher): boolean {
  if (matcher.kind === 'exact') return hostname === matcher.hostname

  const isSubdomain =
    hostname !== matcher.apexHostname && hostname.endsWith(`.${matcher.apexHostname}`)
  if (matcher.kind === 'subdomain') return isSubdomain
  return hostname === matcher.apexHostname || isSubdomain
}

function matchesPath(pathname: string, matcher: WebRoutePathMatcher): boolean {
  if (matcher.kind === 'any') return true
  if (matcher.kind === 'exact') return pathname === matcher.pathname
  return pathname.startsWith(matcher.pathnamePrefix)
}

function buildRedirectTarget(url: URL, behavior: WebRouteBehavior): string | null {
  if (behavior === 'serve') return null

  if (behavior === 'canonical-host-redirect') {
    const target = new URL(url)
    target.protocol = 'https:'
    target.hostname = XID_APEX_HOST
    target.port = ''
    return target.toString()
  }

  const target = new URL(`https://${XID_APEX_HOST}/llms.txt`)
  target.search = url.search
  return target.toString()
}

export function resolveWebRouteOwnership(input: string | URL): WebRouteOwnershipDecision {
  const url = input instanceof URL ? new URL(input) : new URL(input)
  const matches = WEB_ROUTE_OWNERSHIP_RULES.filter(
    (rule) => matchesHost(url.hostname, rule.host) && matchesPath(url.pathname, rule.path),
  ).sort((left, right) => right.priority - left.priority)
  const winner = matches[0]

  if (!winner) {
    return {
      url: url.toString(),
      owner: null,
      matchedRuleId: null,
      behavior: null,
      redirectStatus: null,
      redirectTarget: null,
    }
  }

  const tiedOwners = new Set(
    matches.filter((rule) => rule.priority === winner.priority).map((rule) => rule.owner),
  )
  if (tiedOwners.size !== 1) {
    throw new Error(`Ambiguous Web route ownership for ${url.toString()}`)
  }

  return {
    url: url.toString(),
    owner: winner.owner,
    matchedRuleId: winner.id,
    behavior: winner.behavior,
    redirectStatus: winner.behavior === 'serve' ? null : 308,
    redirectTarget: buildRedirectTarget(url, winner.behavior),
  }
}

export type ExpectedWorkerRoute = {
  pattern: string
  customDomain: boolean
}

export type ExpectedWorkerServiceBinding = {
  binding: string
  service: string
}

const siteExactWorkerRoutes: ExpectedWorkerRoute[] = SITE_EXACT_PATHS.map((pathname) => ({
  pattern: `${XID_APEX_HOST}${pathname}`,
  customDomain: false,
}))

const sitePrefixWorkerRoutes: ExpectedWorkerRoute[] = SITE_PREFIX_PATHS.map((pathnamePrefix) => ({
  pattern: `${XID_APEX_HOST}${pathnamePrefix}*`,
  customDomain: false,
}))

const sitePublicDocExactWorkerRoutes: ExpectedWorkerRoute[] = SITE_PUBLIC_DOC_EXACT_PATHS.map(
  (pathname) => ({
    pattern: `${XID_APEX_HOST}${pathname}`,
    customDomain: false,
  }),
)

const sitePublicDocPrefixWorkerRoutes: ExpectedWorkerRoute[] = SITE_PUBLIC_DOC_PREFIX_PATHS.map(
  (pathnamePrefix) => ({
    pattern: `${XID_APEX_HOST}${pathnamePrefix}*`,
    customDomain: false,
  }),
)

const siteScimDocExactWorkerRoutes: ExpectedWorkerRoute[] = SITE_SCIM_DOC_EXACT_PATHS.map(
  (pathname) => ({
    pattern: `${XID_APEX_HOST}${pathname}`,
    customDomain: false,
  }),
)

const siteLocaleWorkerRoutes: ExpectedWorkerRoute[] = XID_SITE_LOCALES.flatMap((locale) => {
  const routeSegment = XID_SITE_LOCALE_ROUTE_SEGMENTS[locale]
  return [
    { pattern: `${XID_APEX_HOST}/${routeSegment}`, customDomain: false },
    { pattern: `${XID_APEX_HOST}/${routeSegment}/`, customDomain: false },
    { pattern: `${XID_APEX_HOST}/${routeSegment}/*`, customDomain: false },
  ]
})

export const EXPECTED_WORKER_ROUTE_CONFIGS: Readonly<
  Record<WebRouteOwner, readonly ExpectedWorkerRoute[]>
> = {
  site: [
    ...siteScimDocExactWorkerRoutes,
    ...sitePublicDocExactWorkerRoutes,
    ...sitePublicDocPrefixWorkerRoutes,
    ...siteExactWorkerRoutes,
    ...sitePrefixWorkerRoutes,
    ...siteLocaleWorkerRoutes,
    { pattern: `${XID_WWW_HOST}/*`, customDomain: false },
    { pattern: `${XID_WWW_HOST}${CONSOLE_EXACT_PATH}`, customDomain: false },
    { pattern: `${XID_WWW_HOST}${CONSOLE_PREFIX_PATH}*`, customDomain: false },
  ],
  console: [
    { pattern: `${XID_APEX_HOST}${CONSOLE_EXACT_PATH}`, customDomain: false },
    { pattern: `${XID_APEX_HOST}${CONSOLE_PREFIX_PATH}*`, customDomain: false },
    { pattern: `*.${XID_APEX_HOST}${CONSOLE_EXACT_PATH}`, customDomain: false },
    { pattern: `*.${XID_APEX_HOST}${CONSOLE_PREFIX_PATH}*`, customDomain: false },
  ],
  core: [
    { pattern: XID_APEX_HOST, customDomain: true },
    { pattern: `*.${XID_APEX_HOST}/*`, customDomain: false },
    { pattern: '*/*', customDomain: false },
  ],
}

export const EXPECTED_WORKER_SERVICE_BINDINGS: Readonly<
  Record<WebRouteOwner, readonly ExpectedWorkerServiceBinding[]>
> = {
  site: [],
  console: [],
  core: [
    { binding: FRONTEND_WORKER_SERVICE_BINDING_NAMES.site, service: 'xid-site' },
    { binding: FRONTEND_WORKER_SERVICE_BINDING_NAMES.console, service: 'xid-console' },
  ],
}
