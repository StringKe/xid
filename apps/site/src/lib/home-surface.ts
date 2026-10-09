import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { translateSiteMessage } from './site-i18n.ts'
import { getSiteLlmsIndexPath, localizeSitePath, SITE_LOCALES } from './site-locale.ts'
import type { SiteLocale } from './site-locale.ts'

export const homeMessages = {
  title: msg`One identity product for your app and your customers`,
  description: msg`XID is one identity product for your app and your customers: hosted sign-in and accounts, OpenID Connect for your apps, organizations with enterprise SSO and SCIM, and one console. Free on XID Cloud, MIT licensed to self-host.`,
  heroQuestion: msg`Your customers need sign-in, SSO and admins.`,
  heroAnswer: msg`XID is one product for all of it.`,
  heroLead: msg`Hosted sign-in, OIDC, SSO and SCIM per organization, one console.`,
  startFreeOnCloud: msg`Start free on XID Cloud`,
  selfHost: msg`Self-host XID`,
  heroNote: msg`Free today. No plans or tiers.`,
  signInQuestion: msg`You don't want to build sign‑in and account pages.`,
  signInAnswer: msg`XID hosts them in your brand.`,
  signInLead: msg`Your app redirects to XID and gets the user back with tokens. Afterward, people manage their sessions, devices and data on their own account page.`,
  signInLink: msg`Hosted sign-in docs`,
  signInEvidence: msg`Email link and code sign-in: verified in production on xid.dev. Other sign-in methods and the account page: verified locally.`,
  oidcQuestion: msg`Your auth vendor shouldn't be in every service.`,
  oidcAnswer: msg`XID is a standard OpenID Connect provider.`,
  oidcLead: msg`Use our SDKs or any OIDC library. Access tokens are signed JWTs that carry the organization, and your backend verifies them without a network call.`,
  oidcLink: msg`Connect your app`,
  oidcEvidence: msg`Authorization code flow: verified locally with protocol clients. SDKs are distributed as source in the XID repository.`,
  accessToken: msg`Example access token`,
  decodedPayload: msg`Decoded header and payload`,
  exampleTokenNote: msg`Example values in the shape XID issues. This is not a real token.`,
  ssoQuestion: msg`Your biggest deal is waiting on SSO and SCIM.`,
  ssoAnswer: msg`Every customer gets an organization with both.`,
  ssoLead: msg`Each organization has its own SAML or OIDC connection, SCIM directory, verified domains and MFA policy. When IT deactivates someone, XID ends their sessions.`,
  ssoLink: msg`Enterprise SSO docs`,
  ssoEvidence: msg`Verified locally against test identity providers. Not yet verified with a live Okta or Entra ID tenant.`,
  consoleQuestion: msg`Every customer's SSO setup lands in your support queue.`,
  consoleAnswer: msg`Their admins can do it themselves.`,
  consoleLead: msg`One console for you and them. You see every organization; their admins see only theirs, with the same pages for members, SSO, branding and audit logs.`,
  consoleLink: msg`Organizations docs`,
  consoleEvidence: msg`Switching organizations in the console: verified in production on xid.dev.`,
  cloudQuestion: msg`Choosing hosted shouldn't lock you in.`,
  cloudAnswer: msg`Cloud and self‑hosted are one product.`,
  cloudLead: msg`XID Cloud is free today. If it ever charges, it bills only per monthly active user, never by plan. Self-hosted, billing is off unless you turn it on.`,
  factLicense: msg`License`,
  factCodebase: msg`Codebase for Cloud and self-hosted`,
  factWorkers: msg`Cloudflare Workers`,
  factLanguages: msg`Interface languages`,
  selfHostingGuide: msg`Self-hosting guide`,
  seePricing: msg`See pricing`,
} as const satisfies Record<string, MessageDescriptor>

type HomeMessageKey = keyof typeof homeMessages

export type HomeFact = { value: string; label: string }

export type HomeSurface = {
  locale: SiteLocale
  path: string
  markdownPath: string
  sourcePath: string
  llmsIndexPath: string
  title: string
  description: string
  text: Readonly<Record<HomeMessageKey, string>>
  facts: readonly HomeFact[]
}

// 事实条只放可核对的结构事实：LICENSE、一份代码、apps/{site,console,server} 三个 Worker、lingui 的语言数。
const WORKER_COUNT = 3
const CODEBASE_COUNT = 1

export function getHomeSurface(locale: SiteLocale): HomeSurface {
  const path = localizeSitePath('/', locale)
  const entries = Object.entries(homeMessages) as [HomeMessageKey, MessageDescriptor][]
  const text = Object.fromEntries(
    entries.map(([key, descriptor]) => [key, translateSiteMessage(path, descriptor)]),
  ) as Record<HomeMessageKey, string>
  return {
    locale,
    path,
    markdownPath: path === '/' ? '/index.md' : `${path}/index.md`,
    sourcePath: path === '/' ? '/index.mdx' : `${path}/index.mdx`,
    llmsIndexPath: getSiteLlmsIndexPath(locale),
    title: text.title,
    description: text.description,
    text,
    facts: [
      { value: 'MIT', label: text.factLicense },
      { value: String(CODEBASE_COUNT), label: text.factCodebase },
      { value: String(WORKER_COUNT), label: text.factWorkers },
      { value: String(SITE_LOCALES.length), label: text.factLanguages },
    ],
  }
}

function absoluteUrl(pathname: string, siteOrigin: string): string {
  return new URL(pathname, siteOrigin).href
}

function frontmatter(surface: HomeSurface, siteOrigin: string): readonly string[] {
  return [
    '---',
    `title: ${JSON.stringify(surface.title)}`,
    `description: ${JSON.stringify(surface.description)}`,
    `locale: ${JSON.stringify(surface.locale)}`,
    `image: ${JSON.stringify(absoluteUrl('/og.png', siteOrigin))}`,
    '---',
  ]
}

const SECTIONS: readonly (readonly [
  HomeMessageKey,
  HomeMessageKey,
  HomeMessageKey,
  HomeMessageKey?,
])[] = [
  ['signInQuestion', 'signInAnswer', 'signInLead', 'signInEvidence'],
  ['oidcQuestion', 'oidcAnswer', 'oidcLead', 'oidcEvidence'],
  ['ssoQuestion', 'ssoAnswer', 'ssoLead', 'ssoEvidence'],
  ['consoleQuestion', 'consoleAnswer', 'consoleLead', 'consoleEvidence'],
  ['cloudQuestion', 'cloudAnswer', 'cloudLead'],
]

function renderHomeBody(surface: HomeSurface): readonly string[] {
  const { text } = surface
  const lines = [
    `# ${surface.title}`,
    '',
    surface.description,
    '',
    `## ${text.heroQuestion} ${text.heroAnswer}`,
    '',
    text.heroLead,
    '',
    text.heroNote,
    '',
  ]
  for (const [question, answer, lead, evidence] of SECTIONS) {
    lines.push(`## ${text[question]} ${text[answer]}`, '', text[lead], '')
    if (evidence) lines.push(text[evidence], '')
  }
  for (const fact of surface.facts) lines.push(`- **${fact.value}:** ${fact.label}`)
  lines.push('')
  return lines
}

export function renderHomeMarkdown(locale: SiteLocale, siteOrigin = 'https://xid.dev'): string {
  const surface = getHomeSurface(locale)
  return [
    ...frontmatter(surface, siteOrigin),
    '',
    '> Documentation Index',
    `> Fetch the relevant documentation index at: ${absoluteUrl(surface.llmsIndexPath, siteOrigin)}`,
    '> Use this file to discover all available pages before exploring further.',
    '',
    ...renderHomeBody(surface),
    `Source: ${absoluteUrl(surface.sourcePath, siteOrigin)}`,
    '',
  ].join('\n')
}

export function renderHomeMdx(locale: SiteLocale, siteOrigin = 'https://xid.dev'): string {
  const surface = getHomeSurface(locale)
  return [...frontmatter(surface, siteOrigin), '', ...renderHomeBody(surface)].join('\n')
}

export function renderHomeCorpus(
  locale: SiteLocale,
  siteOrigin = 'https://xid.dev',
): readonly string[] {
  const surface = getHomeSurface(locale)
  return [
    `<!-- xid-doc-path: ${surface.path} -->`,
    '<!-- xid-doc-slug: product -->',
    `# ${surface.title}`,
    '',
    `> ${surface.description}`,
    '',
    `Locale: ${surface.locale}`,
    `Canonical: ${absoluteUrl(surface.path, siteOrigin)}`,
    `Markdown: ${absoluteUrl(surface.markdownPath, siteOrigin)}`,
    `Source: ${absoluteUrl(surface.sourcePath, siteOrigin)}`,
    '',
    ...renderHomeBody(surface).slice(4),
  ]
}
