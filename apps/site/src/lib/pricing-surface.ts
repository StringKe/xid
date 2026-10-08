import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import apiContracts from '../../../../docs/api-contracts.md?raw'
import sourceMap from '../../../../docs/protocols/source-map.md?raw'
import {
  capabilityGrade,
  parseProductionContracts,
  parseSourceMapLevels,
  type CapabilityEvidence,
  type EvidenceGrade,
} from './pricing-evidence'
import { translateSiteMessage } from './site-i18n'
import {
  getSiteLlmsIndexPath,
  localizeSitePath,
  SITE_LOCALES,
  SITE_LOCALE_ROUTE_SEGMENTS,
} from './site-locale'
import type { SiteLocale } from './site-locale'

export const pricingMessages = {
  title: msg`XID Cloud is free.`,
  description: msg`No plans, no tiers, no paid features. If XID Cloud ever charges, it bills only for monthly active users. Self-hosted XID has the same features, with billing off unless you turn it on.`,
  cloudName: msg`XID Cloud`,
  cloudOperator: msg`Operated by XID on xid.dev.`,
  cloudPrice: msg`Free today`,
  cloudEveryFeature: msg`Every feature`,
  cloudOrganizations: msg`An organization for your company, and one for each of your customers`,
  cloudSubdomain: msg`Hosted pages on your organization's subdomain of xid.dev`,
  startFreeOnCloud: msg`Start free on XID Cloud`,
  selfHostedName: msg`Self-hosted`,
  selfHostedOperator: msg`Run it in your own Cloudflare account.`,
  selfHostedPrice: msg`Free, MIT licensed`,
  selfHostedNoLicense: msg`No license key, and nothing reports back to XID`,
  selfHostedCloudflare: msg`You pay Cloudflare for what your account uses`,
  selfHostingGuide: msg`Self-hosting guide`,
  chargingTitle: msg`If XID Cloud starts charging`,
  usageOnlyTitle: msg`Usage only`,
  usageOnlyBody: msg`It bills per monthly active user, and nothing else.`,
  noPlansTitle: msg`No plans`,
  noPlansBody: msg`No feature is ever reserved for paying customers. There are no plans to upgrade to.`,
  nothingOffTitle: msg`Nothing switches off`,
  nothingOffBody: msg`Billing never signs anyone out or turns off a feature you use.`,
  usageTitle: msg`How usage is counted`,
  usageBody: msg`A monthly active user is a person who signs in at least once in a calendar month (UTC). Each person counts once per month across your organization and all of its sub-organizations, however often they sign in. Guest sessions don't count. Your console overview shows the number as Monthly active users.`,
  featuresTitle: msg`Everything is included in both`,
  featuresSource: msg`Status from the public evidence matrix`,
  featuresSourceNarrow: msg`Same on XID Cloud and self-hosted. Status from the public evidence matrix.`,
  featureColumn: msg`Feature`,
  statusColumn: msg`Status`,
  included: msg`Included`,
  showAllFeatures: msg`Show all features`,
  featuresNote: msg`Status comes from the public evidence matrix in the repository. Only rows marked Production are verified on xid.dev. Self-hosted deployments also get the instance console for every organization on the deployment.`,
  groupSignIn: msg`Sign-in`,
  groupHostedOrganizations: msg`Hosted pages and organizations`,
  groupEnterpriseDevelopers: msg`Enterprise and developers`,
  featureEmailCode: msg`Email code and magic link`,
  featurePasskeys: msg`Passkeys`,
  featureMfa: msg`MFA: authenticator app, SMS, backup codes, passkey`,
  featurePasswordSocial: msg`Password with breach checks, social sign-in`,
  featureHostedSignIn: msg`Hosted sign-in page`,
  featureAccountLanguages: msg`Account page, eight interface languages`,
  featureSwitchOrganizations: msg`Switch organizations in one console`,
  featureOrganizations: msg`Sub-organizations, members, roles, branding, domain verification`,
  featureEnterpriseSso: msg`Inbound SAML and OIDC SSO, inbound SCIM 2.0, XID as identity provider`,
  featureOidc: msg`OpenID Connect: authorization code, PAR, DPoP`,
  featureManagementApi: msg`Management API`,
  featureWebhooksAudit: msg`Signed webhooks, hash-chained audit log`,
  featureSdks: msg`SDKs`,
  gradeProduction: msg`Production`,
  gradeProductionCore: msg`Production, core paths`,
  gradeLocalEndToEnd: msg`Verified end to end, local`,
  gradeIntegration: msg`Integration-tested`,
  gradeImplemented: msg`Implemented`,
  gradeUnpublished: msg`Not yet published to npm`,
  questionsTitle: msg`Questions`,
  faqPayQuestion: msg`Do I need to pay for SSO, SCIM or MFA?`,
  faqPayAnswer: msg`No. There are no plans or tiers. Every feature is available on XID Cloud and when you self-host.`,
  faqReadyQuestion: msg`Is XID ready for production?`,
  faqReadyAnswer: msg`XID is pre-1.0. Hosted sign-in, the console and the Management API core paths are verified in production on xid.dev. Enterprise identity providers, social sign-in and SMS are verified locally only.`,
  faqChargingQuestion: msg`Will XID Cloud start charging?`,
  faqChargingAnswer: msg`It is free today. If it ever charges, it bills only per monthly active user, and no feature is reserved for paying customers.`,
  faqLimitsQuestion: msg`Are there usage limits on XID Cloud?`,
  faqLimitsAnswer: msg`None by default. If one is set, it only stops creating new sub-organizations or SSO connections. No limit stops sign-in, sign-up, SSO or SCIM provisioning, or token refresh.`,
  faqMoveQuestion: msg`Can I move from XID Cloud to self-hosting?`,
  faqMoveAnswer: msg`It's the same code. You can export users with the Management API; password hashes are not exported, and passkeys need to be registered again on the new domain. There is no one-step migration tool.`,
  faqCostQuestion: msg`What does self-hosting cost?`,
  faqCostAnswer: msg`Nothing to XID. You pay Cloudflare for what your account uses, and sending email to any recipient needs the Workers Paid plan. You also need a domain whose DNS you control.`,
  faqDataQuestion: msg`Where is my data on XID Cloud?`,
  faqDataAnswer: msg`In XID's Cloudflare account, on D1, KV, R2 and Durable Objects. Choosing a data region isn't available.`,
  faqComplianceQuestion: msg`Do you have SOC 2 or ISO 27001?`,
  faqComplianceAnswer: msg`Not yet.`,
  closing: msg`Pre-1.0. Core paths of hosted sign-in, the console and the Management API are verified in production on xid.dev. Everything else is verified locally.`,
} as const satisfies Record<string, MessageDescriptor>

type PricingMessageKey = keyof typeof pricingMessages

export type PricingBadge = 'success' | 'info' | 'neutral' | 'outline'

type CapabilityDefinition = {
  label: PricingMessageKey
  highlight?: boolean
  evidence: CapabilityEvidence | 'unpublished'
  coreProductionPaths?: boolean
}

type CapabilityGroupDefinition = {
  label: PricingMessageKey
  rows: readonly CapabilityDefinition[]
}

const HOSTED_CONFIG = { method: 'GET', path: '/auth/config' } as const
const ACTIVE_ORGANIZATION = { method: 'POST', path: '/v1/sessions/active-organization' } as const
const PLATFORM_ORGANIZATIONS = { method: 'GET', path: '/v1/platform/organizations' } as const

const CAPABILITY_GROUPS: readonly CapabilityGroupDefinition[] = [
  {
    label: 'groupSignIn',
    rows: [
      {
        label: 'featureEmailCode',
        highlight: true,
        evidence: {
          sourceMapFeatures: [],
          productionContracts: [HOSTED_CONFIG, ACTIVE_ORGANIZATION],
        },
      },
      {
        label: 'featurePasskeys',
        highlight: true,
        evidence: {
          sourceMapFeatures: [
            'WebAuthn registration',
            'WebAuthn authentication',
            'Discoverable credentials',
          ],
        },
      },
      {
        label: 'featureMfa',
        evidence: { sourceMapFeatures: ['TOTP MFA', 'Backup codes', 'SMS MFA', 'Passkey as MFA'] },
      },
      {
        label: 'featurePasswordSocial',
        evidence: {
          sourceMapFeatures: [
            'NIST AAL1',
            'Apple social OAuth provider',
            'Google social OAuth provider',
            'Microsoft account social OAuth provider',
            'GitHub social OAuth provider',
          ],
        },
      },
    ],
  },
  {
    label: 'groupHostedOrganizations',
    rows: [
      {
        label: 'featureHostedSignIn',
        highlight: true,
        evidence: { sourceMapFeatures: [], productionContracts: [HOSTED_CONFIG] },
      },
      {
        label: 'featureAccountLanguages',
        evidence: {
          sourceMapFeatures: [
            'Session cookie and /v1/me',
            'Self-service privacy export and erasure',
          ],
        },
      },
      {
        label: 'featureSwitchOrganizations',
        evidence: { sourceMapFeatures: [], productionContracts: [ACTIVE_ORGANIZATION] },
      },
      {
        label: 'featureOrganizations',
        evidence: {
          sourceMapFeatures: [
            'Self-service top-level Tenant onboarding',
            'Organization invitation accept',
            'OAuth organization context selection',
          ],
        },
      },
    ],
  },
  {
    label: 'groupEnterpriseDevelopers',
    rows: [
      {
        label: 'featureEnterpriseSso',
        highlight: true,
        evidence: {
          sourceMapFeatures: [
            'SP-initiated login',
            'SAML ACS',
            'OIDC enterprise JIT',
            'SCIM Users',
            'SCIM Groups',
            'Outbound SAML IdP SSO endpoint',
          ],
        },
      },
      {
        label: 'featureOidc',
        evidence: { sourceMapFeatures: ['Authorization code', 'PAR', 'DPoP'] },
      },
      {
        label: 'featureManagementApi',
        coreProductionPaths: true,
        evidence: {
          sourceMapFeatures: [],
          productionContracts: [PLATFORM_ORGANIZATIONS, ACTIVE_ORGANIZATION],
        },
      },
      {
        label: 'featureWebhooksAudit',
        evidence: { sourceMapFeatures: ['Webhook delivery', 'Audit event hash chain'] },
      },
      { label: 'featureSdks', highlight: true, evidence: 'unpublished' },
    ],
  },
]

const GRADE_PRESENTATION: Readonly<
  Record<EvidenceGrade, { label: PricingMessageKey; badge: PricingBadge }>
> = {
  production: { label: 'gradeProduction', badge: 'success' },
  'local-e2e': { label: 'gradeLocalEndToEnd', badge: 'info' },
  integration: { label: 'gradeIntegration', badge: 'neutral' },
  implemented: { label: 'gradeImplemented', badge: 'neutral' },
}

const EVIDENCE_SOURCES = {
  levels: parseSourceMapLevels(sourceMap),
  production: parseProductionContracts(apiContracts),
}

export type EvidenceStatus = {
  label: MessageDescriptor
  badge: PricingBadge
}

export function evidenceStatus(
  evidence: CapabilityEvidence,
  options: { coreProductionPaths?: boolean } = {},
): EvidenceStatus {
  const grade = capabilityGrade(evidence, EVIDENCE_SOURCES)
  const shown = GRADE_PRESENTATION[grade]
  const label =
    grade === 'production' && options.coreProductionPaths ? 'gradeProductionCore' : shown.label
  return { label: pricingMessages[label], badge: shown.badge }
}

function presentation(row: CapabilityDefinition): EvidenceStatus {
  if (row.evidence === 'unpublished') {
    return { label: pricingMessages.gradeUnpublished, badge: 'outline' }
  }
  return evidenceStatus(row.evidence, { coreProductionPaths: row.coreProductionPaths })
}

export type PricingCapability = {
  label: string
  status: string
  badge: PricingBadge
  highlight: boolean
}

export type PricingCapabilityGroup = {
  label: string
  rows: readonly PricingCapability[]
}

export type PricingQuestion = { question: string; answer: string }

export type PricingSurface = {
  locale: SiteLocale
  path: string
  markdownPath: string
  sourcePath: string
  llmsIndexPath: string
  text: Readonly<Record<PricingMessageKey, string>>
  groups: readonly PricingCapabilityGroup[]
  questions: readonly PricingQuestion[]
}

const QUESTIONS: readonly (readonly [PricingMessageKey, PricingMessageKey])[] = [
  ['faqPayQuestion', 'faqPayAnswer'],
  ['faqReadyQuestion', 'faqReadyAnswer'],
  ['faqChargingQuestion', 'faqChargingAnswer'],
  ['faqLimitsQuestion', 'faqLimitsAnswer'],
  ['faqMoveQuestion', 'faqMoveAnswer'],
  ['faqCostQuestion', 'faqCostAnswer'],
  ['faqDataQuestion', 'faqDataAnswer'],
  ['faqComplianceQuestion', 'faqComplianceAnswer'],
]

export function getPricingSurface(locale: SiteLocale): PricingSurface {
  const path = localizeSitePath('/pricing', locale)
  const entries = Object.entries(pricingMessages) as [PricingMessageKey, MessageDescriptor][]
  const text = Object.fromEntries(
    entries.map(([key, descriptor]) => [key, translateSiteMessage(path, descriptor)]),
  ) as Record<PricingMessageKey, string>
  return {
    locale,
    path,
    markdownPath: `${path}/index.md`,
    sourcePath: `${path}/index.mdx`,
    llmsIndexPath: getSiteLlmsIndexPath(locale),
    text,
    groups: CAPABILITY_GROUPS.map((group) => ({
      label: text[group.label],
      rows: group.rows.map((row) => {
        const shown = presentation(row)
        return {
          label: text[row.label],
          status: translateSiteMessage(path, shown.label),
          badge: shown.badge,
          highlight: row.highlight === true,
        }
      }),
    })),
    questions: QUESTIONS.map(([question, answer]) => ({
      question: text[question],
      answer: text[answer],
    })),
  }
}

export function getLocalizedPricingStaticPaths(): Array<{
  params: { lang: string }
  props: { locale: SiteLocale }
}> {
  return SITE_LOCALES.filter((locale) => locale !== 'en').map((locale) => ({
    params: { lang: SITE_LOCALE_ROUTE_SEGMENTS[locale] },
    props: { locale },
  }))
}

function absoluteUrl(pathname: string, siteOrigin: string): string {
  return new URL(pathname, siteOrigin).href
}

function frontmatter(surface: PricingSurface, siteOrigin: string): readonly string[] {
  return [
    '---',
    `title: ${JSON.stringify(surface.text.title)}`,
    `description: ${JSON.stringify(surface.text.description)}`,
    `locale: ${JSON.stringify(surface.locale)}`,
    `image: ${JSON.stringify(absoluteUrl('/og.png', siteOrigin))}`,
    '---',
  ]
}

function renderPricingBody(surface: PricingSurface): readonly string[] {
  const { text } = surface
  const lines = [
    `# ${text.title}`,
    '',
    text.description,
    '',
    `## ${text.cloudName}: ${text.cloudPrice}`,
    '',
    text.cloudOperator,
    '',
    `- ${text.cloudEveryFeature}`,
    `- ${text.cloudOrganizations}`,
    `- ${text.cloudSubdomain}`,
    '',
    `## ${text.selfHostedName}: ${text.selfHostedPrice}`,
    '',
    text.selfHostedOperator,
    '',
    `- ${text.cloudEveryFeature}`,
    `- ${text.selfHostedNoLicense}`,
    `- ${text.selfHostedCloudflare}`,
    '',
    `## ${text.chargingTitle}`,
    '',
    `- **${text.usageOnlyTitle}:** ${text.usageOnlyBody}`,
    `- **${text.noPlansTitle}:** ${text.noPlansBody}`,
    `- **${text.nothingOffTitle}:** ${text.nothingOffBody}`,
    '',
    `## ${text.usageTitle}`,
    '',
    text.usageBody,
    '',
    `## ${text.featuresTitle}`,
    '',
  ]
  for (const group of surface.groups) {
    lines.push(`### ${group.label}`, '')
    for (const row of group.rows) lines.push(`- ${row.label}: ${row.status}`)
    lines.push('')
  }
  lines.push(text.featuresNote, '', `## ${text.questionsTitle}`, '')
  for (const item of surface.questions) lines.push(`### ${item.question}`, '', item.answer, '')
  lines.push(text.closing, '')
  return lines
}

export function renderPricingMarkdown(locale: SiteLocale, siteOrigin = 'https://xid.dev'): string {
  const surface = getPricingSurface(locale)
  return [
    ...frontmatter(surface, siteOrigin),
    '',
    '> Documentation Index',
    `> Fetch the relevant documentation index at: ${absoluteUrl(surface.llmsIndexPath, siteOrigin)}`,
    '> Use this file to discover all available pages before exploring further.',
    '',
    ...renderPricingBody(surface),
    `Source: ${absoluteUrl(surface.sourcePath, siteOrigin)}`,
    '',
  ].join('\n')
}

export function renderPricingMdx(locale: SiteLocale, siteOrigin = 'https://xid.dev'): string {
  const surface = getPricingSurface(locale)
  return [...frontmatter(surface, siteOrigin), '', ...renderPricingBody(surface)].join('\n')
}

export function renderPricingCorpus(
  locale: SiteLocale,
  siteOrigin = 'https://xid.dev',
): readonly string[] {
  const surface = getPricingSurface(locale)
  return [
    `<!-- xid-doc-path: ${surface.path} -->`,
    '<!-- xid-doc-slug: pricing -->',
    `# ${surface.text.title}`,
    '',
    `> ${surface.text.description}`,
    '',
    `Locale: ${surface.locale}`,
    `Canonical: ${absoluteUrl(surface.path, siteOrigin)}`,
    `Markdown: ${absoluteUrl(surface.markdownPath, siteOrigin)}`,
    `Source: ${absoluteUrl(surface.sourcePath, siteOrigin)}`,
    '',
    ...renderPricingBody(surface).slice(4),
  ]
}
