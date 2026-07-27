import {
  d1,
  DEFAULT_INSTANCE_ORG_ID,
  printResult,
  productionBaseUrl,
  productionSurfaceBaseUrl,
  requireProductionEmail,
  sqlString,
} from './production-auth.mjs'
import { PUBLIC_DOC_ALIASES, PUBLIC_DOC_SLUGS } from '../../../packages/types/src/public-docs.ts'
import {
  PUBLIC_DOC_SECTIONS,
  llmsFullOk,
  llmsOk,
  llmsSectionFullOk,
  llmsSectionOk,
  sitemapOk,
} from './public-content-checks.mjs'
import { webRedirectLocationMatches, webRouteOwnerMatches } from './web-route-owner.mjs'

const baseUrl = productionBaseUrl()
const siteBaseUrl = productionSurfaceBaseUrl('XID_PRODUCTION_SITE_BASE_URL')
const consoleBaseUrl = productionSurfaceBaseUrl('XID_PRODUCTION_CONSOLE_BASE_URL')
const coreBaseUrl = productionSurfaceBaseUrl('XID_PRODUCTION_CORE_BASE_URL')
const surfaceBaseUrls = {
  site: siteBaseUrl,
  console: consoleBaseUrl,
  core: coreBaseUrl,
}
// 这里曾经是第二份独立的 org id 字面量,重建生产库后只改一处就会出现一半 smoke 打新租户、
// 一半打旧租户;改成复用 harness 的单一来源(它自己带 XID_PRODUCTION_TENANT_ID 覆盖口)。
const tenantId = DEFAULT_INSTANCE_ORG_ID
const defaultEmail = requireProductionEmail('XID_PRODUCTION_EMAIL')
const defaultSmsPhone = process.env['XID_PRODUCTION_SMS_GATE_PHONE'] ?? '+15555550123'
const defaultWhatsappPhone = process.env['XID_PRODUCTION_WHATSAPP_GATE_PHONE'] ?? '+15555550124'

function emailAlias(email, tag) {
  const index = email.lastIndexOf('@')
  if (index <= 0 || index === email.length - 1) return email
  return `${email.slice(0, index)}+xid-${tag}@${email.slice(index + 1)}`
}

const forgotPasswordEmail =
  process.env['XID_PRODUCTION_FORGOT_PASSWORD_EMAIL'] ??
  emailAlias(defaultEmail, `pwreset-${Date.now()}`)

// docs/goal、docs/verification、docs/current-gap-audit、docs/implementation-status 的 markdown 已删除,
// 条目仍保留:线上公开页面永远不得出现这些路径,防止未来复用同名 slug 时静默泄露。
const forbiddenPublicDocsPatterns = [
  'docs/design',
  'docs/goal',
  'docs/verification',
  'docs/deployment',
  'docs/api-contracts',
  'docs/current-gap-audit',
  'docs/implementation-status',
  'docs/soft-delete',
  '完整功能设计',
  '设计真相源',
]

export function publicDocsBodyOk(body) {
  return (
    body.includes('XID') &&
    body.includes('data-ai-agent-directive') &&
    body.includes('data-nb-sidebar') &&
    body.includes('data-search-dialog') &&
    forbiddenPublicDocsPatterns.every((item) => !body.includes(item))
  )
}

export function enterpriseSsoDocsOk(body) {
  return (
    publicDocsBodyOk(body) &&
    body.includes('Legacy protocol boundaries') &&
    body.includes('must not be described as production-supported') &&
    !body.includes('Kerberos is fully supported in Workers')
  )
}

function publicDocsPathForSlug(slug) {
  return `/${slug}`
}

function publicDocsCheckForSlug(slug) {
  return slug === 'enterprise-sso' ? enterpriseSsoDocsOk : publicDocsBodyOk
}

function defaultAuthConfigOk(json) {
  return (
    json?.resolution?.status === 'ready' &&
    json?.identifierMode === 'email' &&
    json?.requireVerifiedEmail === true &&
    Array.isArray(json?.allowedEmailDomains) &&
    json.allowedEmailDomains.length === 0 &&
    Array.isArray(json?.blockedEmailDomains) &&
    json.blockedEmailDomains.length === 0 &&
    json?.forceSso === false &&
    json?.allowUserCreation === true &&
    json?.allowExistingUserLogin === true &&
    json?.profileFields?.email === 'required' &&
    json?.profileFields?.username === 'hidden' &&
    json?.profileFields?.phone === 'hidden' &&
    json?.profileFields?.name === 'hidden' &&
    json?.profileFields?.givenName === 'hidden' &&
    json?.profileFields?.familyName === 'hidden' &&
    json?.methods?.magicLink?.enabled === true &&
    json?.methods?.magicLink?.allowLogin === true &&
    json?.methods?.magicLink?.allowUserCreation === true &&
    json?.methods?.emailOtp?.enabled === true &&
    json?.methods?.emailOtp?.allowLogin === true &&
    json?.methods?.emailOtp?.allowUserCreation === true &&
    json?.methods?.password?.enabled === false &&
    json?.methods?.password?.allowLogin === false &&
    json?.methods?.password?.allowUserCreation === false &&
    json?.methods?.whatsappOtp?.enabled === false &&
    json?.methods?.whatsappOtp?.allowLogin === false &&
    json?.methods?.whatsappOtp?.allowUserCreation === false &&
    json?.methods?.smsOtp?.enabled === false &&
    json?.methods?.smsOtp?.allowLogin === false &&
    json?.methods?.smsOtp?.allowUserCreation === false &&
    json?.methods?.passkey?.enabled === false &&
    json?.methods?.passkey?.allowLogin === false &&
    json?.methods?.passkey?.allowUserCreation === false &&
    json?.methods?.enterpriseSso?.enabled === false &&
    json?.methods?.enterpriseSso?.allowLogin === false &&
    json?.methods?.enterpriseSso?.allowJitUserCreation === false &&
    json?.methods?.enterpriseSso?.domainDiscovery === false &&
    Array.isArray(json?.socialProviders) &&
    json.socialProviders.length === 0
  )
}

function canonicalJson(value) {
  return JSON.stringify(value)
}

const docsHomeTextRequired = [
  '<title>XID Developer Docs | XID</title>',
  'XID developer documentation',
  'Protocol, API, inbound enterprise SSO, SCIM, SDK, and self-hosting references',
  'href="/getting-started"',
  'href="/hosted-auth"',
  'href="/oidc-oauth"',
  'href="/enterprise-sso"',
  'href="/social-login"',
  'href="/scim"',
  'href="/management-api"',
  'href="/sdks"',
  'href="/self-hosting"',
]

const docsHomeSeoPatternRequired = [
  /<meta\s+[^>]*name="description"[^>]*content="Protocol, API, inbound enterprise SSO, SCIM, SDK, and self-hosting references/u,
  /<link\s+[^>]*rel="canonical"[^>]*href="https:\/\/xid\.dev\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="en"[^>]*href="https:\/\/xid\.dev\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="zh-Hans"[^>]*href="https:\/\/xid\.dev\/zh-hans\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="ja"[^>]*href="https:\/\/xid\.dev\/ja\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="ko"[^>]*href="https:\/\/xid\.dev\/ko\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="fr"[^>]*href="https:\/\/xid\.dev\/fr\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="de"[^>]*href="https:\/\/xid\.dev\/de\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="es"[^>]*href="https:\/\/xid\.dev\/es\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="pt-BR"[^>]*href="https:\/\/xid\.dev\/pt-br\/"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*hreflang="x-default"[^>]*href="https:\/\/xid\.dev\/"[^>]*>/u,
  /<meta\s+[^>]*property="og:type"[^>]*content="website"[^>]*>/u,
  /<meta\s+[^>]*property="og:title"[^>]*content="XID Developer Docs \| XID"[^>]*>/u,
  /<meta\s+[^>]*property="og:image"[^>]*content="https:\/\/xid\.dev\/og\/[^"]+\.png"[^>]*>/u,
  /<meta\s+[^>]*name="twitter:card"[^>]*content="summary_large_image"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*type="text\/plain"[^>]*href="https:\/\/xid\.dev\/llms\.txt"[^>]*>/u,
  /<link\s+[^>]*rel="alternate"[^>]*type="text\/markdown"[^>]*href="https:\/\/xid\.dev\/index\.md"[^>]*>/u,
]

function docsHomeJsonLdOk(body) {
  const match = body.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)
  if (!match) return false
  try {
    const parsed = JSON.parse(match[1])
    return (
      parsed['@type'] === 'WebSite' &&
      parsed.url === 'https://xid.dev/' &&
      parsed.inLanguage === 'en' &&
      parsed.image === 'https://xid.dev/og/index.png'
    )
  } catch {
    return false
  }
}

export function docsHomeOk(body) {
  return (
    publicDocsBodyOk(body) &&
    docsHomeTextRequired.every((item) => body.includes(item)) &&
    docsHomeSeoPatternRequired.every((pattern) => pattern.test(body)) &&
    docsHomeJsonLdOk(body)
  )
}

export function robotsOk(body) {
  const required = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /sign-in',
    'Disallow: /sign-up',
    'Disallow: /account',
    'Disallow: /console',
    'Disallow: /auth',
    'Disallow: /v1',
    'Sitemap: https://xid.dev/sitemap.xml',
  ]
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return required.every((item) => lines.includes(item))
}

const internalDocsPaths = [
  '/docs/design',
  '/docs/goal',
  '/docs/verification',
  '/docs/deployment',
  '/docs/api-contracts',
  '/docs/current-gap-audit',
  '/docs/implementation-status',
  '/docs/soft-delete',
  '/docs/i18n',
  '/docs/api',
  '/docs/not-published',
]

const legacyRedirectSearch = '?xid_smoke=1&client=agent'

function localizedLegacyPath(routeSegment, pathname) {
  return routeSegment === '' ? pathname : `/${routeSegment}${pathname}`
}

function localizedPublicDocsPath(routeSegment, slug = null) {
  if (slug === null) return routeSegment === '' ? '/' : `/${routeSegment}/`
  return routeSegment === '' ? `/${slug}` : `/${routeSegment}/${slug}`
}

function redirectName(pathname) {
  return pathname
    .replace(/^\/+/u, '')
    .replaceAll('/', '-')
    .replaceAll('.', '-')
    .replaceAll('_', '-')
}

function legacyRedirectCheck(name, sourcePath, canonicalPath) {
  return {
    name,
    surface: 'site',
    path: `${sourcePath}${legacyRedirectSearch}`,
    expectStatus: 308,
    expectLocation: (location) =>
      webRedirectLocationMatches(location, siteBaseUrl, canonicalPath, legacyRedirectSearch),
  }
}

const legacyCanonicalDocsChecks = PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment, section }) => [
  legacyRedirectCheck(
    `legacy-${section}-docs-hub`,
    localizedLegacyPath(routeSegment, '/docs'),
    localizedPublicDocsPath(routeSegment),
  ),
  ...PUBLIC_DOC_SLUGS.map((slug) =>
    legacyRedirectCheck(
      `legacy-${section}-docs-${slug.replaceAll('/', '-')}`,
      localizedLegacyPath(routeSegment, `/docs/${slug}`),
      localizedPublicDocsPath(routeSegment, slug),
    ),
  ),
])

const legacyAliasChecks = PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment, section }) =>
  Object.entries(PUBLIC_DOC_ALIASES)
    .filter(([path, slug]) => path !== `/docs/${slug}`)
    .map(([path, slug]) =>
      legacyRedirectCheck(
        `legacy-${section}-alias-${redirectName(path)}`,
        localizedLegacyPath(routeSegment, path),
        localizedPublicDocsPath(routeSegment, slug),
      ),
    ),
)

const legacyTwinChecks = PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment, section }) => {
  const legacyHub = localizedLegacyPath(routeSegment, '/docs')
  const canonicalHub = localizedPublicDocsPath(routeSegment).replace(/\/$/u, '')
  const legacyScim = localizedLegacyPath(routeSegment, '/docs/scim')
  const canonicalScim = localizedPublicDocsPath(routeSegment, 'scim')
  return ['md', 'mdx'].flatMap((extension) => [
    legacyRedirectCheck(
      `legacy-${section}-hub-${extension}`,
      `${legacyHub}/index.${extension}`,
      `${canonicalHub}/index.${extension}`,
    ),
    legacyRedirectCheck(
      `legacy-${section}-scim-${extension}`,
      `${legacyScim}/index.${extension}`,
      `${canonicalScim}/index.${extension}`,
    ),
  ])
})

const legacyAliasTwinChecks = PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment, section }) =>
  ['md', 'mdx'].map((extension) =>
    legacyRedirectCheck(
      `legacy-${section}-oidc-alias-${extension}`,
      `${localizedLegacyPath(routeSegment, '/docs/oidc')}/index.${extension}`,
      `${localizedPublicDocsPath(routeSegment, 'oidc-oauth')}/index.${extension}`,
    ),
  ),
)

const legacyAgentIndexChecks = PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment, section }) => {
  const legacyRoot = localizedLegacyPath(routeSegment, '/docs')
  return ['llms.txt', 'llms-full.txt'].map((filename) =>
    legacyRedirectCheck(
      `legacy-${section}-${filename.replaceAll('.', '-')}`,
      `${legacyRoot}/${filename}`,
      `/${section}/${filename}`,
    ),
  )
})

const sectionAgentIndexChecks = PUBLIC_DOC_SECTIONS.flatMap(({ section }) => [
  {
    name: `${section}-llms`,
    surface: 'site',
    path: `/${section}/llms.txt`,
    expectStatus: 200,
    expectBody: (body) => llmsSectionOk(body, section),
  },
  {
    name: `${section}-llms-full`,
    surface: 'site',
    path: `/${section}/llms-full.txt`,
    expectStatus: 200,
    expectBody: (body) => llmsSectionFullOk(body, section),
  },
])

const checks = [
  {
    name: 'docs-root',
    surface: 'site',
    path: '/',
    expectStatus: 200,
    expectBody: docsHomeOk,
  },
  {
    name: 'robots',
    surface: 'site',
    path: '/robots.txt',
    expectStatus: 200,
    expectBody: robotsOk,
  },
  {
    name: 'sitemap',
    surface: 'site',
    path: '/sitemap.xml',
    expectStatus: 200,
    expectBody: sitemapOk,
  },
  {
    name: 'llms',
    surface: 'site',
    path: '/llms.txt',
    expectStatus: 200,
    expectBody: llmsOk,
  },
  {
    name: 'llms-full',
    surface: 'site',
    path: '/llms-full.txt',
    expectStatus: 200,
    expectBody: llmsFullOk,
  },
  {
    name: 'well-known-llms',
    surface: 'core',
    path: '/.well-known/llms.txt?client=agent',
    expectStatus: 308,
    expectLocation: (location) =>
      webRedirectLocationMatches(location, baseUrl, '/llms.txt', '?client=agent'),
  },
  ...sectionAgentIndexChecks,
  {
    name: 'health',
    surface: 'core',
    path: '/v1/health',
    expectStatus: 200,
    expectBody: (body) => body.includes('"ok":true'),
  },
  ...PUBLIC_DOC_SLUGS.map((slug) => ({
    name: `docs-${slug.replaceAll('/', '-')}`,
    surface: 'site',
    path: publicDocsPathForSlug(slug),
    expectStatus: 200,
    expectBody: publicDocsCheckForSlug(slug),
  })),
  ...PUBLIC_DOC_SECTIONS.filter(({ routeSegment }) => routeSegment !== '').flatMap(
    ({ routeSegment, section }) => [
      {
        name: `docs-${section}-hub`,
        surface: 'site',
        path: localizedPublicDocsPath(routeSegment),
        expectStatus: 200,
        expectBody: publicDocsBodyOk,
      },
      {
        name: `docs-${section}-scim`,
        surface: 'site',
        path: localizedPublicDocsPath(routeSegment, 'scim'),
        expectStatus: 200,
        expectBody: publicDocsBodyOk,
      },
    ],
  ),
  ...legacyCanonicalDocsChecks,
  ...legacyAliasChecks,
  ...legacyTwinChecks,
  ...legacyAliasTwinChecks,
  ...legacyAgentIndexChecks,
  // 下面这组 blocked 断言覆盖历史内部文档 slug,其中 goal / verification / current-gap-audit /
  // implementation-status 的 markdown 已从仓库删除。断言保留:公开路由是 allowlist deny-by-default,
  // 这里锁死"历史 slug 永远 404",避免未来有人复用同名 slug 建公开文档时静默暴露。
  ...internalDocsPaths.map((path) => ({
    name: `${path.slice('/docs/'.length).replaceAll('/', '-')}-docs-blocked`,
    surface: 'site',
    path,
    expectStatus: 404,
    expectBody: (body) => body.includes('Page not found'),
  })),
  {
    name: 'console-shell',
    surface: 'console',
    path: '/console',
    expectStatus: 200,
    expectBody: (body) => body.includes('<div id="root">'),
  },
  {
    name: 'console-sessions-account-alias',
    surface: 'console',
    path: '/console/sessions?from=smoke',
    expectStatus: 302,
    expectLocation: (location) =>
      webRedirectLocationMatches(location, consoleBaseUrl, '/account/sessions', '?from=smoke'),
  },
  {
    name: 'console-security-account-alias',
    surface: 'console',
    path: '/console/security?from=smoke',
    expectStatus: 302,
    expectLocation: (location) =>
      webRedirectLocationMatches(location, consoleBaseUrl, '/account/security', '?from=smoke'),
  },
  {
    name: 'sign-in',
    surface: 'core',
    path: '/sign-in',
    expectStatus: 200,
    expectBody: (body) => body.includes('XID') || body.includes('root'),
  },
  {
    name: 'sign-up-unified-entry',
    surface: 'core',
    path: '/sign-up',
    expectStatus: 200,
    expectBody: (body) => body.includes('XID') || body.includes('root'),
  },
  {
    name: 'auth-config-root-default-org',
    surface: 'core',
    path: '/auth/config',
    expectStatus: 200,
    expectJson: defaultAuthConfigOk,
  },
  {
    name: 'oidc-discovery-root',
    surface: 'core',
    path: '/.well-known/openid-configuration',
    expectStatus: 200,
    expectJson: (json) => json?.issuer === baseUrl && json?.jwks_uri === `${baseUrl}/jwks`,
  },
  {
    name: 'jwks',
    surface: 'core',
    path: '/jwks',
    expectStatus: 200,
    expectJson: (json) => Array.isArray(json?.keys) && json.keys.length > 0,
  },
]

const gateChecks = [
  {
    name: 'password-disabled-gate',
    path: '/auth/password/sign-in',
    method: 'POST',
    body: { identifier: defaultEmail, password: 'xid-production-smoke-not-a-password' },
    expectStatus: 401,
    expectJson: (json) => json?.code === 'invalid_credentials',
    expectNoSessionCookie: true,
  },
  {
    name: 'passkey-disabled-gate',
    path: '/auth/passkey/login/options',
    method: 'POST',
    body: { email: defaultEmail },
    expectStatus: 400,
    expectJson: (json) => json?.code === 'invalid_request',
    expectNoSessionCookie: true,
  },
  {
    name: 'social-google-not-configured-gate',
    path: '/auth/google/authorize',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) =>
      json?.code === 'invalid_request' &&
      typeof json?.longMessage === 'string' &&
      json.longMessage.includes('Provider google not configured'),
    expectNoRedirect: true,
    expectNoSessionCookie: true,
  },
  {
    name: 'enterprise-sso-disabled-hrd',
    path: '/sso/hrd',
    method: 'POST',
    body: { email: defaultEmail },
    expectStatus: 200,
    expectJson: (json) => json?.connectionId === null,
    expectNoSessionCookie: true,
  },
  {
    name: 'social-google-callback-invalid-state-gate',
    path: '/auth/google/callback?code=xid-production-smoke-code&state=xid-production-smoke-state',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) =>
      json?.code === 'invalid_request' &&
      typeof json?.longMessage === 'string' &&
      json.longMessage === 'state_invalid',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
  {
    name: 'social-google-callback-missing-params-gate',
    path: '/auth/google/callback',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) => json?.code === 'invalid_request',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
  {
    name: 'enterprise-saml-metadata-missing-connection-gate',
    path: '/sso/saml/conn_xid_production_smoke/metadata',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) => json?.code === 'connection_not_found',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
  {
    name: 'enterprise-saml-acs-missing-connection-gate',
    path: '/sso/saml/conn_xid_production_smoke/acs',
    method: 'POST',
    expectStatus: 400,
    expectJson: (json) => json?.code === 'connection_not_found',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
  {
    name: 'enterprise-saml-login-missing-connection-gate',
    path: '/sso/saml/conn_xid_production_smoke/login',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) => json?.code === 'connection_not_found',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
  {
    name: 'enterprise-oidc-authorize-missing-connection-gate',
    path: '/sso/oidc/conn_xid_production_smoke/authorize',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) => json?.code === 'connection_not_found',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
  {
    name: 'enterprise-oidc-callback-invalid-state-gate',
    path: '/sso/oidc/conn_xid_production_smoke/callback?code=xid-production-smoke-code&state=xid-production-smoke-state',
    method: 'GET',
    expectStatus: 400,
    expectJson: (json) =>
      json?.code === 'invalid_request' &&
      typeof json?.longMessage === 'string' &&
      json.longMessage === 'state_invalid',
    expectNoRedirect: true,
    expectNoSessionCookie: true,
    expectJsonRoute: true,
  },
]

const phoneGateChecks = [
  {
    name: 'sms-otp-disabled-gate',
    channel: 'sms',
    method: 'smsOtp',
    phone: defaultSmsPhone,
    path: '/auth/otp/sms/send',
  },
  {
    name: 'whatsapp-otp-disabled-gate',
    channel: 'whatsapp',
    method: 'whatsappOtp',
    phone: defaultWhatsappPhone,
    path: '/auth/otp/whatsapp/send',
  },
]

export async function runProductionSmoke() {
  const results = []
  let failed = false

  for (const check of checks) {
    const url = check.url ?? `${surfaceBaseUrls[check.surface]}${check.path}`
    try {
      const res = await fetch(url, { redirect: 'manual' })
      const body = await res.text()
      const statusOk = res.status === check.expectStatus
      const ownerOk = webRouteOwnerMatches(res.headers, check.surface)
      let headerOk = true
      if (check.expectHeader) {
        const [name, value] = check.expectHeader
        headerOk = res.headers.get(name) === value
      }
      const locationOk = !check.expectLocation || check.expectLocation(res.headers.get('location'))
      let bodyOk = true
      if (check.expectBody) bodyOk = check.expectBody(body)
      let jsonOk = true
      if (check.expectJson) {
        try {
          jsonOk = check.expectJson(JSON.parse(body))
        } catch {
          jsonOk = false
        }
      }
      const ok = statusOk && ownerOk && headerOk && locationOk && bodyOk && jsonOk
      if (!ok) failed = true
      results.push({
        name: check.name,
        status: ok ? 'PASS' : 'FAIL',
        httpStatus: res.status,
        routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
        url,
      })
    } catch (error) {
      failed = true
      results.push({
        name: check.name,
        status: 'FAIL',
        httpStatus: 'ERROR',
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const check of gateChecks) {
    const url = `${coreBaseUrl}${check.path}`
    try {
      const res = await fetch(url, {
        method: check.method,
        redirect: 'manual',
        headers: check.body ? { 'content-type': 'application/json' } : undefined,
        body: check.body ? JSON.stringify(check.body) : undefined,
      })
      const body = await res.text()
      const statusOk = res.status === check.expectStatus
      const location = res.headers.get('location')
      const setCookie = res.headers.get('set-cookie') ?? ''
      const contentType = res.headers.get('content-type') ?? ''
      const redirectOk = !check.expectNoRedirect || location === null
      const cookieOk = !check.expectNoSessionCookie || !setCookie.includes('__Host-xid.rt.')
      const jsonRouteOk = !check.expectJsonRoute || contentType.includes('application/json')
      const ownerOk = webRouteOwnerMatches(res.headers, 'core')
      const notSpaOk =
        !check.expectJsonRoute ||
        (!body.includes('<!doctype html') &&
          !body.includes('id="root"') &&
          !body.includes('<script'))
      let jsonOk = true
      if (check.expectJson) {
        try {
          jsonOk = check.expectJson(JSON.parse(body))
        } catch {
          jsonOk = false
        }
      }
      const ok = statusOk && ownerOk && redirectOk && cookieOk && jsonRouteOk && notSpaOk && jsonOk
      if (!ok) failed = true
      results.push({
        name: check.name,
        status: ok ? 'PASS' : 'FAIL',
        httpStatus: res.status,
        routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
        url,
      })
    } catch (error) {
      failed = true
      results.push({
        name: check.name,
        status: 'FAIL',
        httpStatus: 'ERROR',
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function countRows(command, name) {
    const rows = await d1(command, name)
    const row = rows[0]
    return Number(row?.count ?? 0)
  }

  function policyDeniedWhere(input, afterMs) {
    const clauses = [
      `tenant_id = ${sqlString(tenantId)}`,
      "event_type = 'auth.policy_denied'",
      `json_extract(meta, '$.method') = ${sqlString(input.method)}`,
      `json_extract(meta, '$.action') = ${sqlString(input.action)}`,
      `CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 >= ${afterMs}`,
    ]
    if (input.identifierType) {
      clauses.push(`json_extract(meta, '$.identifierType') = ${sqlString(input.identifierType)}`)
      clauses.push("json_extract(meta, '$.identifierHash') IS NOT NULL")
    }
    if (input.path) clauses.push(`json_extract(meta, '$.path') = ${sqlString(input.path)}`)
    if (input.reason) clauses.push(`json_extract(meta, '$.reason') = ${sqlString(input.reason)}`)
    return clauses.join('\n  AND ')
  }

  async function waitForPolicyDenied(input, afterMs, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs
    let count = 0
    while (Date.now() < deadline) {
      count = await countRows(
        `
SELECT count(*) AS count
FROM audit_events
WHERE ${policyDeniedWhere(input, afterMs)};
`,
        `load ${input.name} policy denied audit`,
      )
      if (count > 0) return count
      await new Promise((resolve) => {
        setTimeout(resolve, 1500)
      })
    }
    return count
  }

  async function checkMagicLinkVerifyRouteGate() {
    const path = '/auth/magic-link/verify?token=bad.jwt.sig'
    const url = `${coreBaseUrl}${path}`
    try {
      const res = await fetch(url, { redirect: 'manual' })
      const body = await res.text()
      const setCookie = res.headers.get('set-cookie') ?? ''
      const contentType = res.headers.get('content-type') ?? ''
      let jsonOk = false
      try {
        jsonOk = JSON.parse(body)?.code === 'magic_link_invalid'
      } catch {
        jsonOk = false
      }
      const bodyIsNotSpa =
        !body.includes('<!doctype html') && !body.includes('id="root"') && !body.includes('<script')
      const ok =
        res.status === 400 &&
        webRouteOwnerMatches(res.headers, 'core') &&
        contentType.includes('application/json') &&
        jsonOk &&
        bodyIsNotSpa &&
        !setCookie.includes('__Host-xid.rt.')
      if (!ok) failed = true
      results.push({
        name: 'magic-link-verify-route-json-gate',
        status: ok ? 'PASS' : 'FAIL',
        httpStatus: res.status,
        routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
        url,
      })
    } catch (error) {
      failed = true
      results.push({
        name: 'magic-link-verify-route-json-gate',
        status: 'FAIL',
        httpStatus: 'ERROR',
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function checkForgotPasswordDisabledGate() {
    const path = '/auth/forgot-password'
    const url = `${coreBaseUrl}${path}`
    const afterMs = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: forgotPasswordEmail }),
      })
      const body = await res.text()
      const setCookie = res.headers.get('set-cookie') ?? ''
      let jsonOk = false
      try {
        jsonOk = JSON.parse(body)?.ok === true
      } catch {
        jsonOk = false
      }
      const resetTokenCount = await countRows(
        `
SELECT count(*) AS count
FROM password_reset_tokens
WHERE tenant_id = ${sqlString(tenantId)}
  AND created_at >= ${afterMs};
`,
        'load password reset token count',
      )
      const tokenIssuedCount = await countRows(
        `
SELECT count(*) AS count
FROM audit_events
WHERE tenant_id = ${sqlString(tenantId)}
  AND event_type = 'auth.token_issued'
  AND json_extract(meta, '$.purpose') = 'password_reset'
  AND CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 >= ${afterMs};
`,
        'load password reset token issued audit count',
      )
      const sentAuditCount = await countRows(
        `
SELECT count(*) AS count
FROM audit_events
WHERE tenant_id = ${sqlString(tenantId)}
  AND event_type = 'notification.sent'
  AND json_extract(meta, '$.type') = 'password_reset'
  AND CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 >= ${afterMs};
`,
        'load password reset notification sent audit count',
      )
      const policyDeniedInput = {
        name: 'forgot password',
        method: 'password',
        action: 'login',
        identifierType: 'email',
        path,
        reason: 'method_disabled',
      }
      const policyDeniedCount = await waitForPolicyDenied(policyDeniedInput, afterMs)
      const policyDeniedLeakCount = await countRows(
        `
SELECT count(*) AS count
FROM audit_events
WHERE ${policyDeniedWhere(policyDeniedInput, afterMs)}
  AND instr(CAST(meta AS TEXT), ${sqlString(forgotPasswordEmail)}) > 0;
`,
        'load forgot password policy denied leak count',
      )
      const ok =
        res.status === 200 &&
        webRouteOwnerMatches(res.headers, 'core') &&
        jsonOk &&
        !setCookie.includes('__Host-xid.rt.') &&
        resetTokenCount === 0 &&
        tokenIssuedCount === 0 &&
        sentAuditCount === 0 &&
        policyDeniedCount > 0 &&
        policyDeniedLeakCount === 0
      if (!ok) failed = true
      results.push({
        name: 'forgot-password-disabled-gate',
        status: ok ? 'PASS' : 'FAIL',
        httpStatus: res.status,
        routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
        url,
      })
    } catch (error) {
      failed = true
      results.push({
        name: 'forgot-password-disabled-gate',
        status: 'FAIL',
        httpStatus: 'ERROR',
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function checkDefaultAuthConfigResolvers() {
    const variants = [
      {
        name: 'auth-config-login-hint-default-org',
        path: `/auth/config?login_hint=${encodeURIComponent(defaultEmail)}`,
        displayPath: '/auth/config?login_hint=[redacted]',
      },
      {
        name: 'auth-config-organization-id-default-org',
        path: `/auth/config?organization_id=${encodeURIComponent(tenantId)}`,
      },
    ]
    const baselineRes = await fetch(`${coreBaseUrl}/auth/config`, { redirect: 'manual' })
    const baselineText = await baselineRes.text()
    let baseline
    try {
      baseline = JSON.parse(baselineText)
    } catch {
      baseline = null
    }
    const baselineTextCanonical = canonicalJson(baseline)
    for (const variant of variants) {
      const url = `${coreBaseUrl}${variant.path}`
      try {
        const res = await fetch(url, { redirect: 'manual' })
        const text = await res.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        const ok =
          baselineRes.status === 200 &&
          webRouteOwnerMatches(baselineRes.headers, 'core') &&
          res.status === 200 &&
          webRouteOwnerMatches(res.headers, 'core') &&
          defaultAuthConfigOk(baseline) &&
          defaultAuthConfigOk(json) &&
          canonicalJson(json) === baselineTextCanonical
        if (!ok) failed = true
        results.push({
          name: variant.name,
          status: ok ? 'PASS' : 'FAIL',
          httpStatus: res.status,
          routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
          url: `${coreBaseUrl}${variant.displayPath ?? variant.path}`,
        })
      } catch (error) {
        failed = true
        results.push({
          name: variant.name,
          status: 'FAIL',
          httpStatus: 'ERROR',
          url: `${coreBaseUrl}${variant.displayPath ?? variant.path}`,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async function checkDefaultOrgBootstrapShape() {
    try {
      const rows = await d1(
        `
SELECT
  o.id,
  o.tenant_id,
  o.slug,
  o.status,
  o.parent_org_id,
  i.primary_domain,
  i.status AS instance_status,
  u.primary_email_id,
  ue.id AS email_id,
  ue.verified,
  ue.is_primary,
  ma.manager_role,
  ma.scope_type,
  ma.scope_id,
  m.role AS membership_role,
  m.status AS membership_status
FROM organizations o
JOIN instances i ON i.id = o.instance_id
JOIN user_emails ue ON ue.tenant_id = o.tenant_id
JOIN users u ON u.id = ue.user_id AND u.tenant_id = o.tenant_id
LEFT JOIN manager_assignments ma
  ON ma.tenant_id = o.tenant_id
  AND ma.user_id = u.id
  AND ma.manager_role = 'instance_manager'
  AND ma.scope_type = 'instance'
  AND ma.scope_id IS NULL
LEFT JOIN memberships m
  ON m.tenant_id = o.tenant_id
  AND m.org_id = o.id
  AND m.user_id = u.id
  AND m.role = 'owner'
  AND m.status = 'active'
WHERE o.id = ${sqlString(tenantId)}
  AND ue.email = ${sqlString(defaultEmail)}
LIMIT 1;
`,
        'load default organization bootstrap shape',
      )
      const row = rows[0]
      const ok =
        row?.id === tenantId &&
        row?.tenant_id === tenantId &&
        row?.slug === 'default' &&
        row?.status === 'active' &&
        row?.parent_org_id === null &&
        row?.primary_domain === new URL(baseUrl).hostname &&
        row?.instance_status === 'active' &&
        typeof row?.primary_email_id === 'string' &&
        row.primary_email_id === row?.email_id &&
        Number(row?.verified) === 1 &&
        Number(row?.is_primary) === 1 &&
        row?.manager_role === 'instance_manager' &&
        row?.scope_type === 'instance' &&
        row?.scope_id === null &&
        row?.membership_role === 'owner' &&
        row?.membership_status === 'active'
      if (!ok) failed = true
      results.push({
        name: 'default-org-bootstrap-shape',
        status: ok ? 'PASS' : 'FAIL',
        httpStatus: rows.length,
        url: 'remote-d1:xid-db/default-org',
      })
    } catch (error) {
      failed = true
      results.push({
        name: 'default-org-bootstrap-shape',
        status: 'FAIL',
        httpStatus: 'ERROR',
        url: 'remote-d1:xid-db/default-org',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await checkMagicLinkVerifyRouteGate()
  await checkForgotPasswordDisabledGate()
  await checkDefaultAuthConfigResolvers()
  await checkDefaultOrgBootstrapShape()

  for (const check of phoneGateChecks) {
    const url = `${coreBaseUrl}${check.path}`
    const afterMs = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: check.phone, turnstileToken: null }),
      })
      const body = await res.text()
      const setCookie = res.headers.get('set-cookie') ?? ''
      let jsonOk = false
      try {
        jsonOk = JSON.parse(body)?.ok === true
      } catch {
        jsonOk = false
      }
      const tokenCount = await countRows(
        `
SELECT count(*) AS count
FROM verification_tokens vt
JOIN user_phones up ON up.user_id = vt.user_id
WHERE up.phone = ${sqlString(check.phone)}
  AND vt.purpose = 'otp'
  AND vt.channel = ${sqlString(check.channel)}
  AND vt.created_at >= ${afterMs};
`,
        `load ${check.channel} otp token count`,
      )
      const sentAuditCount = await countRows(
        `
SELECT count(*) AS count
FROM audit_events
WHERE tenant_id = ${sqlString(tenantId)}
  AND event_type = 'notification.sent'
  AND json_extract(meta, '$.channel') = ${sqlString(check.channel)}
  AND CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 >= ${afterMs};
`,
        `load ${check.channel} notification sent audit count`,
      )
      // tokenCount 走 verification_tokens JOIN user_phones,门在建 user_phones 之前拦住时它恒为 0,
      // 但门若哪天挪到 resolveTargetUserId 之后,新建的 user_phones 就会被这条 JOIN 漏掉。
      // 这个 harness 的全部价值是"证明负路径不写库",所以直接数 user_phones 本身。
      const phoneRowCount = await countRows(
        `
SELECT count(*) AS count
FROM user_phones
WHERE phone = ${sqlString(check.phone)}
  AND created_at >= ${afterMs};
`,
        `load ${check.channel} gate user phone count`,
      )
      const policyDeniedCount = await waitForPolicyDenied(
        {
          name: check.channel,
          method: check.method,
          action: 'availability',
          identifierType: 'phone',
          path: check.path,
        },
        afterMs,
      )
      const ok =
        res.status === 200 &&
        webRouteOwnerMatches(res.headers, 'core') &&
        jsonOk &&
        !setCookie.includes('__Host-xid.rt.') &&
        tokenCount === 0 &&
        phoneRowCount === 0 &&
        sentAuditCount === 0 &&
        policyDeniedCount > 0
      if (!ok) failed = true
      results.push({
        name: check.name,
        status: ok ? 'PASS' : 'FAIL',
        httpStatus: res.status,
        routeOwner: res.headers.get('x-xid-route-owner') ?? 'implicit-core',
        url,
      })
    } catch (error) {
      failed = true
      results.push({
        name: check.name,
        status: 'FAIL',
        httpStatus: 'ERROR',
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const result of results) {
    const error = result.error ? ` error=${result.error}` : ''
    const owner = result.routeOwner ? ` owner=${result.routeOwner}` : ''
    printResult(
      result.status,
      result.name,
      `http=${result.httpStatus}${owner} url=${result.url}${error}`,
    )
  }

  if (failed) throw new Error('production smoke failed')
}
