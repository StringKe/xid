// 审计句子:passkey 吊销、attestation 可信根、出站 SAML 签名证书轮换与 MAU 计量补报。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Strong, useAuditNames } from './AuditSentenceParts'
import type { AuditEntry } from './overview-queries'

export const SECURITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user.passkey_revoked',
  'organization.webauthn_trusted_roots.updated',
  'outbound_saml_signing_certificate.next_published',
  'outbound_saml_signing_certificate.expiring',
  'outbound_saml_signing_certificate.prepared',
  'outbound_saml_signing_certificate.activated',
  'billing.meter_report.marked_reported',
  'billing.meter_report.reported_again',
])

function payloadString(entry: AuditEntry, key: string): string {
  const value = entry.payload[key]
  return typeof value === 'string' ? value : ''
}

function payloadNumber(entry: AuditEntry, key: string): number {
  const value = entry.payload[key]
  return typeof value === 'number' ? value : 0
}

function TrustedRootsSentence({ entry, actor }: { entry: AuditEntry; actor: string }): ReactNode {
  const fingerprints = entry.payload['fingerprints']
  const count = Array.isArray(fingerprints) ? fingerprints.length : 0
  if (count === 0) {
    return (
      <Trans>
        <Strong>{actor}</Strong> removed all passkey attestation trusted roots
      </Trans>
    )
  }
  return (
    <Trans>
      <Strong>{actor}</Strong> replaced the passkey attestation trusted roots, {count} in total
    </Trans>
  )
}

function ExpiringCertificateSentence({ entry }: { entry: AuditEntry }): ReactNode {
  const { i18n } = useLingui()
  const notAfter = payloadString(entry, 'notAfter')
  const date = notAfter ? i18n.date(new Date(notAfter), { dateStyle: 'medium' }) : ''
  if (entry.payload['expired'] === true) {
    return <Trans>The SAML signing certificate for outbound apps expired on {date}</Trans>
  }
  return <Trans>The SAML signing certificate for outbound apps expires on {date}</Trans>
}

function MeterReportSentence({ entry, actor }: { entry: AuditEntry; actor: string }): ReactNode {
  const period = payloadString(entry, 'period')
  const value = payloadNumber(entry, 'value')
  if (entry.eventType === 'billing.meter_report.reported_again') {
    return (
      <Trans>
        <Strong>{actor}</Strong> sent the {period} MAU report ({value}) to Stripe again
      </Trans>
    )
  }
  return (
    <Trans>
      <Strong>{actor}</Strong> marked the {period} MAU report ({value}) as already received by
      Stripe
    </Trans>
  )
}

export function SecurityEventSentence({ entry }: { entry: AuditEntry }): ReactNode {
  const { actor, target } = useAuditNames(entry)
  switch (entry.eventType) {
    case 'user.passkey_revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> removed a passkey from <Strong>{target}</Strong>
        </Trans>
      )
    case 'organization.webauthn_trusted_roots.updated':
      return <TrustedRootsSentence entry={entry} actor={actor} />
    case 'outbound_saml_signing_certificate.next_published':
      return (
        <Trans>
          <Strong>{actor}</Strong> published the next SAML signing certificate for outbound apps
        </Trans>
      )
    case 'outbound_saml_signing_certificate.expiring':
      return <ExpiringCertificateSentence entry={entry} />
    case 'outbound_saml_signing_certificate.prepared':
      return (
        <Trans>
          <Strong>{actor}</Strong> prepared a new SAML signing certificate for outbound apps
        </Trans>
      )
    case 'outbound_saml_signing_certificate.activated':
      return (
        <Trans>
          <Strong>{actor}</Strong> switched outbound apps to the new SAML signing certificate
        </Trans>
      )
    default:
      return <MeterReportSentence entry={entry} actor={actor} />
  }
}
