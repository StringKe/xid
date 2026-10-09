// 出站 SAML 签名证书:列出 next / active / retiring,顶层组织管理者可准备下一张证书并显式切换。
// 证书属于整个租户,切换后所有 SAML 应用改用新证书,旧证书在重叠期内继续出现在 metadata 中。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { queryKeys, useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { Badge, Button } from '@xid-kit/web-ui/ui'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { detailParts } from './AuthDetailParts'
import { SaveStatus } from './AuthSettingsControls'
import { shortFingerprint } from './auth-format'
import { useCanManageOrg, useIsTenantScopeOrg } from './useOrgTarget'

const WIDE = '@media (min-width: 48rem)'

type CertificateStatus = 'next' | 'active' | 'retiring'

type SigningCertificateRow = {
  id: string
  status: CertificateStatus
  notBefore: string | null
  notAfter: string | null
  retireAfter: string | null
  fingerprint: string
}

type CertificateList = { data: SigningCertificateRow[] }

const styles = stylex.create({
  certRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      [WIDE]: 'minmax(0, 1fr) 7rem 13rem auto',
    },
    alignItems: 'center',
    gap: '0.375rem 1rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
  },
  certHead: {
    display: { default: 'none', [WIDE]: 'grid' },
    gridTemplateColumns: 'minmax(0, 1fr) 7rem 13rem auto',
    gap: '1rem',
    paddingBlock: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  certValid: {
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    paddingTop: '0.75rem',
  },
})

function certificatesKey(orgId: string) {
  return [...queryKeys.orgOutboundSamlApps(orgId), 'signing-certificates'] as const
}

function useSigningCertificates(orgId: string): UseQueryResult<CertificateList, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<CertificateList>(
    certificatesKey(orgId),
    `/v1/organizations/${orgId}/outbound-saml-signing-certificates`,
    { enabled: canManage },
  )
}

function usePrepareCertificate(
  orgId: string,
): UseMutationResult<SigningCertificateRow, XidError, void> {
  return useApiMutation<SigningCertificateRow, void>(
    (api) =>
      api.post<SigningCertificateRow>(
        `/v1/organizations/${orgId}/outbound-saml-signing-certificates`,
        {},
      ),
    { invalidate: [queryKeys.orgOutboundSamlApps(orgId)] },
  )
}

function useActivateCertificate(
  orgId: string,
): UseMutationResult<CertificateList, XidError, string> {
  return useApiMutation<CertificateList, string>(
    (api, certificateId) =>
      api.post<CertificateList>(
        `/v1/organizations/${orgId}/outbound-saml-signing-certificates/${certificateId}/activate`,
        {},
      ),
    { invalidate: [queryKeys.orgOutboundSamlApps(orgId)] },
  )
}

function StatusBadge({ status }: { status: CertificateStatus }): ReactNode {
  if (status === 'active') {
    return (
      <Badge tone="success">
        <Trans>Active</Trans>
      </Badge>
    )
  }
  if (status === 'next') {
    return (
      <Badge tone="neutral">
        <Trans>Next</Trans>
      </Badge>
    )
  }
  return (
    <Badge tone="warning">
      <Trans>Retiring</Trans>
    </Badge>
  )
}

export function OutboundSamlCertificates({
  orgId,
  metadataUrl,
  locked,
}: {
  orgId: string
  metadataUrl: string
  locked: boolean
}): ReactNode {
  const { i18n } = useLingui()
  const isTenantScope = useIsTenantScopeOrg()
  const certificates = useSigningCertificates(orgId)
  const prepare = usePrepareCertificate(orgId)
  const activate = useActivateCertificate(orgId)
  const [confirming, setConfirming] = useState<string | null>(null)
  const rows = certificates.data?.data ?? []
  const next = rows.find((row) => row.status === 'next') ?? null
  const canRotate = isTenantScope && !locked

  if (certificates.isSuccess && rows.length === 0) {
    return (
      <p {...stylex.props(styles.note)}>
        <Trans>XID creates the signing certificate when the first SAML app is added.</Trans>
      </p>
    )
  }

  return (
    <div>
      <div aria-hidden {...stylex.props(styles.certHead)}>
        <span>
          <Trans>Certificate</Trans>
        </span>
        <span>
          <Trans>Status</Trans>
        </span>
        <span>
          <Trans>Valid</Trans>
        </span>
        <span />
      </div>
      <ul {...stylex.props(detailParts.rows)}>
        {rows.map((cert) => {
          const from = formatDate(i18n, cert.notBefore)
          const to = formatDate(i18n, cert.notAfter)
          return (
            <li key={cert.id} {...stylex.props(styles.certRow)}>
              <span title={cert.fingerprint}>SHA-256 {shortFingerprint(cert.fingerprint)}</span>
              <span>
                <StatusBadge status={cert.status} />
              </span>
              <span {...stylex.props(styles.certValid)}>
                <Trans>
                  {from} to {to}
                </Trans>
              </span>
              <a href={metadataUrl} download {...stylex.props(list.filterButton)}>
                <Trans>Metadata</Trans>
              </a>
            </li>
          )
        })}
      </ul>
      {canRotate ? (
        <div {...stylex.props(styles.actions)}>
          {next ? (
            <Button type="button" onClick={() => setConfirming(next.id)}>
              <Trans>Switch to the next certificate…</Trans>
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              isLoading={prepare.isPending}
              onClick={() => prepare.mutate()}
            >
              <Trans>Prepare next certificate</Trans>
            </Button>
          )}
        </div>
      ) : null}
      <SaveStatus error={prepare.error ?? activate.error} saved={false} />
      {confirming ? (
        <ConfirmDialog
          title={<Trans>Switch the signing certificate?</Trans>}
          description={
            <Trans>
              Every SAML app in this organization starts using the next certificate right away. Make
              sure each app already trusts it, either by downloading the metadata again or by
              uploading the certificate. The current certificate stays in the metadata for 7 days.
            </Trans>
          }
          confirmLabel={<Trans>Switch certificate</Trans>}
          isLoading={activate.isPending}
          onConfirm={() => activate.mutate(confirming, { onSettled: () => setConfirming(null) })}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  )
}
