import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { Alert, Badge, Button, EmptyState, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useAcceptDpa, useOrgComplianceDocumentsQuery } from './queries'
import { TenantScopeGate } from './TenantScopeGate'
import type { OrgComplianceDocument } from './types'
import { useOrgTarget } from './useOrgTarget'
import { formatDateTime } from '../../lib/date-format'

const styles = stylex.create({
  list: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 52rem)': 'minmax(0, 7fr) minmax(14rem, 5fr)',
    },
    gap: '1rem',
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  rowTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: '0.9375rem',
    fontWeight: 620,
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    marginTop: '0.625rem',
  },
  detail: {
    margin: '0.625rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
    lineHeight: 1.5,
  },
  checksum: {
    display: 'block',
    marginTop: '0.375rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: {
      default: 'flex-start',
      '@media (min-width: 52rem)': 'flex-end',
    },
    gap: '0.5rem',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '2.25rem',
    paddingInline: '0.875rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-fg'],
    fontSize: '0.8125rem',
    fontWeight: 550,
    textDecoration: 'none',
  },
})

function EvidenceRow({
  document,
  accept,
}: {
  document: OrgComplianceDocument
  accept: ReturnType<typeof useAcceptDpa>
}): ReactNode {
  const { i18n } = useLingui()
  const isDpa = document.documentType === 'dpa'
  return (
    <article {...stylex.props(styles.row)}>
      <div>
        <h2 {...stylex.props(styles.rowTitle)}>{document.title}</h2>
        <div {...stylex.props(styles.meta)}>
          <Badge tone="success">
            <Trans>Available</Trans>
          </Badge>
          <Badge tone="neutral">{document.documentType}</Badge>
          <Badge tone="neutral">{document.version}</Badge>
          {document.acceptedAt ? (
            <Badge tone="success">
              <Trans>Accepted</Trans>
            </Badge>
          ) : null}
        </div>
        {document.acceptedAt ? (
          <p {...stylex.props(styles.detail)}>
            <Trans>Accepted on {formatDateTime(i18n, document.acceptedAt)}.</Trans>
          </p>
        ) : null}
        {document.checksum ? (
          <code {...stylex.props(styles.checksum)}>{document.checksum}</code>
        ) : null}
      </div>
      <div {...stylex.props(styles.actions)}>
        {document.artifactUrl ? (
          <a href={document.artifactUrl} {...stylex.props(styles.link)}>
            <Trans>Download evidence</Trans>
          </a>
        ) : null}
        {isDpa && !document.acceptedAt ? (
          <Button
            variant="primary"
            isLoading={accept.isPending && accept.variables?.documentId === document.id}
            onClick={() => accept.mutate({ documentId: document.id })}
          >
            <Trans>Accept DPA</Trans>
          </Button>
        ) : null}
      </div>
    </article>
  )
}

export default function OrgCompliance(): ReactNode {
  return (
    <TenantScopeGate title={<Trans>Compliance center</Trans>}>
      <CompliancePage />
    </TenantScopeGate>
  )
}

function CompliancePage(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { orgId } = useOrgTarget()
  const query = useOrgComplianceDocumentsQuery(orgId)
  const accept = useAcceptDpa(orgId)

  return (
    <ConsolePage
      title={<Trans>Compliance center</Trans>}
      lead={
        <Trans>
          Review published compliance evidence, verify its checksum, and retain an immutable DPA
          acceptance record for the tenant.
        </Trans>
      }
    >
      {accept.error ? (
        <ConsolePageNotice>
          <Alert tone="error">{errorMessage(accept.error)}</Alert>
        </ConsolePageNotice>
      ) : null}
      <ConsolePageSection>
        {query.isLoading ? (
          <div {...stylex.props(page.loadingCenter)}>
            <Spinner label={t`Loading compliance evidence`} />
          </div>
        ) : query.isError ? (
          <Alert tone="error">
            <Trans>Compliance evidence could not be loaded.</Trans>
          </Alert>
        ) : !query.data || query.data.length === 0 ? (
          <EmptyState
            title={<Trans>No compliance evidence published</Trans>}
            description={
              <Trans>Published reports and agreements will appear here when available.</Trans>
            }
          />
        ) : (
          <div {...stylex.props(styles.list)}>
            {query.data.map((document) => (
              <EvidenceRow key={document.id} document={document} accept={accept} />
            ))}
          </div>
        )}
      </ConsolePageSection>
    </ConsolePage>
  )
}
