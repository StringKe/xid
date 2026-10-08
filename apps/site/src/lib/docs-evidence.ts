import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import apiContracts from '../../../../docs/api-contracts.md?raw'
import sourceMap from '../../../../docs/protocols/source-map.md?raw'
import { homeMessages } from './home-surface'
import { findTableRowLine, type CapabilityEvidence } from './pricing-evidence'
import { evidenceStatus, type PricingBadge } from './pricing-surface'
import { translateSiteMessage } from './site-i18n'
import { SITE_API_CONTRACTS_URL, SITE_SOURCE_MAP_URL } from './site-links'

// 文章导语下的状态提示：等级在构建期由公开证据矩阵算出，链接指向矩阵里第一条依据行。

export const docsEvidenceMessages = {
  evidenceRow: msg`Evidence matrix row`,
  socialLogin: msg`Social sign-in with Apple, Google, Microsoft and GitHub: verified locally against test providers.`,
  managementApi: msg`Core paths: verified in production on xid.dev. Other endpoints: verified locally.`,
  webhooks: msg`Delivery and signature verification: verified locally.`,
} as const satisfies Record<string, MessageDescriptor>

type EvidenceRow =
  | { file: 'source-map'; feature: string }
  | { file: 'api-contracts'; method: string; path: string }

type ArticleEvidence = {
  sentence: MessageDescriptor
  evidence: CapabilityEvidence
  coreProductionPaths?: boolean
}

const HOSTED_CONFIG = { method: 'GET', path: '/auth/config' } as const
const ACTIVE_ORGANIZATION = { method: 'POST', path: '/v1/sessions/active-organization' } as const
const PLATFORM_ORGANIZATIONS = { method: 'GET', path: '/v1/platform/organizations' } as const

const ARTICLES: Readonly<Record<string, ArticleEvidence>> = {
  'hosted-auth': {
    sentence: homeMessages.signInEvidence,
    evidence: { sourceMapFeatures: [], productionContracts: [HOSTED_CONFIG] },
    coreProductionPaths: true,
  },
  'social-login': {
    sentence: docsEvidenceMessages.socialLogin,
    evidence: {
      sourceMapFeatures: [
        'Apple social OAuth provider',
        'Google social OAuth provider',
        'Microsoft account social OAuth provider',
        'GitHub social OAuth provider',
      ],
    },
  },
  'oidc-oauth': {
    sentence: homeMessages.oidcEvidence,
    evidence: { sourceMapFeatures: ['Authorization code', 'PAR', 'DPoP'] },
  },
  'management-api': {
    sentence: docsEvidenceMessages.managementApi,
    evidence: {
      sourceMapFeatures: [],
      productionContracts: [PLATFORM_ORGANIZATIONS, ACTIVE_ORGANIZATION],
    },
    coreProductionPaths: true,
  },
  webhooks: {
    sentence: docsEvidenceMessages.webhooks,
    evidence: { sourceMapFeatures: ['Webhook delivery'] },
  },
  organizations: {
    sentence: homeMessages.consoleEvidence,
    evidence: { sourceMapFeatures: [], productionContracts: [ACTIVE_ORGANIZATION] },
    coreProductionPaths: true,
  },
  'enterprise-sso': {
    sentence: homeMessages.ssoEvidence,
    evidence: { sourceMapFeatures: ['SP-initiated login', 'SAML ACS', 'OIDC enterprise JIT'] },
  },
  saml: {
    sentence: homeMessages.ssoEvidence,
    evidence: {
      sourceMapFeatures: ['SP-initiated login', 'SAML ACS', 'Outbound SAML IdP SSO endpoint'],
    },
  },
  scim: {
    sentence: homeMessages.ssoEvidence,
    evidence: { sourceMapFeatures: ['SCIM Users', 'SCIM Groups'] },
  },
}

function firstRow(evidence: CapabilityEvidence): EvidenceRow {
  const contract = evidence.productionContracts?.[0]
  if (contract) return { file: 'api-contracts', ...contract }
  const feature = evidence.sourceMapFeatures[0]
  if (feature === undefined) throw new Error('Article evidence has no rows')
  return { file: 'source-map', feature }
}

function rowHref(row: EvidenceRow): string {
  if (row.file === 'source-map') {
    return `${SITE_SOURCE_MAP_URL}?plain=1#L${findTableRowLine(sourceMap, [row.feature])}`
  }
  return `${SITE_API_CONTRACTS_URL}?plain=1#L${findTableRowLine(apiContracts, [row.method, row.path])}`
}

export type DocsEvidence = {
  sentence: string
  status: string
  badge: PricingBadge
  rowLabel: string
  rowHref: string
}

export function getDocsEvidence(slug: string, pathname: string): DocsEvidence | undefined {
  const article = ARTICLES[slug]
  if (!article) return undefined
  const status = evidenceStatus(article.evidence, {
    coreProductionPaths: article.coreProductionPaths,
  })
  return {
    sentence: translateSiteMessage(pathname, article.sentence),
    status: translateSiteMessage(pathname, status.label),
    badge: status.badge,
    rowLabel: translateSiteMessage(pathname, docsEvidenceMessages.evidenceRow),
    rowHref: rowHref(firstRow(article.evidence)),
  }
}
