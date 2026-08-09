import { msg } from '@lingui/core/macro'
import { translateSiteMessage } from './site-i18n.ts'
import {
  getSiteLlmsIndexPath,
  localizeSitePath,
  SITE_LOCALE_ROUTE_SEGMENTS,
} from './site-locale.ts'
import type { SiteLocale } from './site-locale.ts'

export const homeMessages = {
  eyebrow: msg`Identity infrastructure for Cloudflare`,
  title: msg`Build identity at the edge, without giving up control`,
  description: msg`XID brings Hosted Auth, OIDC, organizations, enterprise federation, directory sync, and SDKs into one MIT-licensed platform running on Cloudflare Workers.`,
  getStarted: msg`Get started`,
  readDocs: msg`Read the documentation`,
  architectureEyebrow: msg`One deployment model`,
  architectureTitle: msg`Three focused Workers. One identity platform.`,
  architectureDescription: msg`Public content and management stay binding-free. Identity state, protocols, and policy remain in Core.`,
  siteLabel: msg`Site`,
  siteDescription: msg`Product, documentation, search, and agent-readable content`,
  consoleLabel: msg`Console`,
  consoleDescription: msg`Organization and instance management UI`,
  coreLabel: msg`Core`,
  coreDescription: msg`Hosted Auth, protocols, APIs, data, and asynchronous work`,
  licenseLabel: msg`License`,
  runtimeLabel: msg`Runtime`,
  threeWorkers: msg`3 Workers`,
  localesLabel: msg`Public locales`,
  editionLabel: msg`Self-hosting`,
  completeEdition: msg`Complete edition`,
  capabilitiesEyebrow: msg`The product surface`,
  capabilitiesTitle: msg`One control plane from sign-in to enterprise access`,
  capabilitiesDescription: msg`Use the complete platform or adopt the protocol, UI, and SDK layers that fit your architecture.`,
  authenticationTitle: msg`Authentication and account`,
  authenticationDescription: msg`Hosted sign-in, passkeys, password, MFA, session management, consent, and account self-service share one tenant-aware Core.`,
  organizationsTitle: msg`Organizations and access`,
  organizationsDescription: msg`Model organizations, OrgUnits, projects, roles, grants, approval policies, and access requests without creating a separate admin tenant.`,
  federationTitle: msg`Federation and provisioning`,
  federationDescription: msg`Connect inbound SAML and OIDC, downstream SaaS SSO, SCIM, directory sync, and domain discovery behind explicit policy boundaries.`,
  developerTitle: msg`Protocols and developer experience`,
  developerDescription: msg`Ship OIDC and OAuth flows, Management APIs, webhooks, framework SDKs, localized docs, and networkless token verification from one repository.`,
  evidenceEyebrow: msg`Pre-1.0 status`,
  evidenceTitle: msg`Evidence before compatibility claims`,
  evidenceDescription: msg`The protocol matrix separates implemented behavior, local conformance evidence, and production support. SAML is not described as production-ready until it is validated against a real identity provider.`,
  inspectEvidence: msg`Inspect the protocol matrix`,
  openSourceTitle: msg`Open source, inspectable, and self-hostable`,
  openSourceDescription: msg`The MIT-licensed repository includes the complete feature set. Security posture and project governance remain visible through OpenSSF and the public source.`,
  viewSource: msg`View source on GitHub`,
  productHuntAlt: msg`XID, an edge-native identity platform on Cloudflare Workers, featured on Product Hunt`,
  scorecardAlt: msg`OpenSSF Scorecard for XID`,
  bestPracticesAlt: msg`OpenSSF Best Practices badge for XID`,
} as const

export type HomeFeature = {
  title: string
  description: string
  href: string
}

export type HomeSurface = {
  locale: SiteLocale
  routeSegment: string
  path: string
  markdownPath: string
  sourcePath: string
  llmsIndexPath: string
  eyebrow: string
  title: string
  description: string
  getStarted: string
  readDocs: string
  architectureEyebrow: string
  architectureTitle: string
  architectureDescription: string
  architecture: readonly { label: string; description: string }[]
  proofs: readonly { value: string; label: string }[]
  capabilitiesEyebrow: string
  capabilitiesTitle: string
  capabilitiesDescription: string
  features: readonly HomeFeature[]
  evidenceEyebrow: string
  evidenceTitle: string
  evidenceDescription: string
  inspectEvidence: string
  openSourceTitle: string
  openSourceDescription: string
  viewSource: string
  productHuntAlt: string
  scorecardAlt: string
  bestPracticesAlt: string
}

export function getHomeSurface(locale: SiteLocale): HomeSurface {
  const path = localizeSitePath('/', locale)
  const translate = (descriptor: (typeof homeMessages)[keyof typeof homeMessages]) =>
    translateSiteMessage(path, descriptor)
  return {
    locale,
    routeSegment: SITE_LOCALE_ROUTE_SEGMENTS[locale],
    path,
    markdownPath: path === '/' ? '/index.md' : `${path}/index.md`,
    sourcePath: path === '/' ? '/index.mdx' : `${path}/index.mdx`,
    llmsIndexPath: getSiteLlmsIndexPath(locale),
    eyebrow: translate(homeMessages.eyebrow),
    title: translate(homeMessages.title),
    description: translate(homeMessages.description),
    getStarted: translate(homeMessages.getStarted),
    readDocs: translate(homeMessages.readDocs),
    architectureEyebrow: translate(homeMessages.architectureEyebrow),
    architectureTitle: translate(homeMessages.architectureTitle),
    architectureDescription: translate(homeMessages.architectureDescription),
    architecture: [
      {
        label: translate(homeMessages.siteLabel),
        description: translate(homeMessages.siteDescription),
      },
      {
        label: translate(homeMessages.consoleLabel),
        description: translate(homeMessages.consoleDescription),
      },
      {
        label: translate(homeMessages.coreLabel),
        description: translate(homeMessages.coreDescription),
      },
    ],
    proofs: [
      { value: 'MIT', label: translate(homeMessages.licenseLabel) },
      { value: translate(homeMessages.threeWorkers), label: translate(homeMessages.runtimeLabel) },
      { value: '8', label: translate(homeMessages.localesLabel) },
      {
        value: translate(homeMessages.completeEdition),
        label: translate(homeMessages.editionLabel),
      },
    ],
    capabilitiesEyebrow: translate(homeMessages.capabilitiesEyebrow),
    capabilitiesTitle: translate(homeMessages.capabilitiesTitle),
    capabilitiesDescription: translate(homeMessages.capabilitiesDescription),
    features: [
      {
        title: translate(homeMessages.authenticationTitle),
        description: translate(homeMessages.authenticationDescription),
        href: localizeSitePath('/hosted-auth', locale),
      },
      {
        title: translate(homeMessages.organizationsTitle),
        description: translate(homeMessages.organizationsDescription),
        href: localizeSitePath('/organizations', locale),
      },
      {
        title: translate(homeMessages.federationTitle),
        description: translate(homeMessages.federationDescription),
        href: localizeSitePath('/enterprise-sso', locale),
      },
      {
        title: translate(homeMessages.developerTitle),
        description: translate(homeMessages.developerDescription),
        href: localizeSitePath('/oidc-oauth', locale),
      },
    ],
    evidenceEyebrow: translate(homeMessages.evidenceEyebrow),
    evidenceTitle: translate(homeMessages.evidenceTitle),
    evidenceDescription: translate(homeMessages.evidenceDescription),
    inspectEvidence: translate(homeMessages.inspectEvidence),
    openSourceTitle: translate(homeMessages.openSourceTitle),
    openSourceDescription: translate(homeMessages.openSourceDescription),
    viewSource: translate(homeMessages.viewSource),
    productHuntAlt: translate(homeMessages.productHuntAlt),
    scorecardAlt: translate(homeMessages.scorecardAlt),
    bestPracticesAlt: translate(homeMessages.bestPracticesAlt),
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

function renderHomeBody(surface: HomeSurface): readonly string[] {
  const lines = [
    `# ${surface.title}`,
    '',
    surface.description,
    '',
    `## ${surface.architectureTitle}`,
    '',
    surface.architectureDescription,
    '',
  ]
  for (const item of surface.architecture) {
    lines.push(`- **${item.label}:** ${item.description}`)
  }
  lines.push('', `## ${surface.capabilitiesTitle}`, '', surface.capabilitiesDescription, '')
  for (const feature of surface.features) {
    lines.push(`### ${feature.title}`, '', feature.description, '')
  }
  lines.push(
    `## ${surface.evidenceTitle}`,
    '',
    surface.evidenceDescription,
    '',
    `## ${surface.openSourceTitle}`,
    '',
    surface.openSourceDescription,
    '',
  )
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
    ...renderHomeBody(surface).slice(2),
  ]
}
