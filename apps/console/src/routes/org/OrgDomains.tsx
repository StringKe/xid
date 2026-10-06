import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { CopyValue } from './CopyValue'
import { useCreateOrgDomain, useOrgDomainsQuery } from './queries'
import type { OrgDomain } from './types'
import { useOrgTarget } from './useOrgTarget'
import { OrgCustomHostnames } from './OrgCustomHostnames'

const styles = stylex.create({
  addRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  addInputWrap: {
    flex: '1 1 200px',
    minWidth: 0,
  },
  recordStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  mutedSmall: {
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
  },
  domainCode: {
    fontSize: '0.875rem',
    fontFamily: tokens['--xid-font-mono'],
  },
})

function isVerified(row: OrgDomain): boolean {
  return row.verification_status === 'verified'
}

function VerifiedBadge({ verified }: { verified: boolean }): ReactNode {
  return verified ? (
    <Badge tone="success">
      <Trans>Verified</Trans>
    </Badge>
  ) : (
    <Badge tone="warning">
      <Trans>Pending verification</Trans>
    </Badge>
  )
}

function TxtRecord({ row }: { row: OrgDomain }): ReactNode {
  const { t } = useLingui()
  if (isVerified(row)) {
    return row.verified_at ? (
      <span {...stylex.props(styles.mutedSmall)}>
        {new Date(row.verified_at).toLocaleDateString()}
      </span>
    ) : null
  }
  return (
    <div {...stylex.props(styles.recordStack)}>
      <span {...stylex.props(styles.mutedSmall)}>
        <Trans>Name</Trans>
      </span>
      <CopyValue value={row.verification_record.name} label={t`TXT record name`} />
      <span {...stylex.props(styles.mutedSmall)}>
        <Trans>Value</Trans>
      </span>
      <CopyValue value={row.verification_record.value} label={t`TXT record value`} />
    </div>
  )
}

const columns: ColumnDef<OrgDomain>[] = [
  {
    id: 'domain',
    header: () => <Trans>Domain</Trans>,
    cell: ({ row }) => <code {...stylex.props(styles.domainCode)}>{row.original.domain}</code>,
  },
  {
    id: 'verified',
    header: () => <Trans>Verification</Trans>,
    cell: ({ row }) => <VerifiedBadge verified={isVerified(row.original)} />,
    meta: { width: '160px' },
  },
  {
    id: 'token',
    header: () => <Trans>DNS TXT record</Trans>,
    cell: ({ row }) => <TxtRecord row={row.original} />,
  },
]

export default function OrgDomains(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { orgId } = useOrgTarget()
  const domains = useOrgDomainsQuery(orgId)
  const addDomain = useCreateOrgDomain(orgId)

  const [newDomain, setNewDomain] = useState('')
  const [addSuccess, setAddSuccess] = useState(false)

  function handleAdd(e: FormEvent): void {
    e.preventDefault()
    if (!orgId || !newDomain.trim()) return
    setAddSuccess(false)
    addDomain.mutate(
      { domain: newDomain.trim() },
      {
        onSuccess: () => {
          setAddSuccess(true)
          setNewDomain('')
        },
      },
    )
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Domains</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      wide
      title={<Trans>Domains</Trans>}
      lead={
        <Trans>
          Verify email domains for enrollment and routing. Domain removal is managed through the
          Management API.
        </Trans>
      }
    >
      {domains.error ? (
        <ConsolePageNotice>
          <Alert tone="error">{errorMessage(domains.error)}</Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Domain list</Trans>}>
        <DataTable
          columns={columns}
          data={domains.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={domains.isLoading}
          emptyMessage={<Trans>No domains added yet.</Trans>}
        />
        <Pagination query={domains} loadMoreLabel={<Trans>Load more domains</Trans>} />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Add domain</Trans>}
        description={
          <Trans>
            Add an email domain, then create the DNS TXT record shown in the table with the exact
            name and value. Verification runs automatically once a day. Verified domains route
            sign-in for matching email addresses to this tenant.
          </Trans>
        }
      >
        <form onSubmit={handleAdd} noValidate>
          <div {...stylex.props(styles.addRow)}>
            <div {...stylex.props(styles.addInputWrap)}>
              <Field label={<Trans>Domain</Trans>} error={errorMessage(addDomain.error)} required>
                <Input
                  type="text"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder={t`example.com`}
                  required
                  aria-label={t`Organization email domain`}
                />
              </Field>
            </div>
            <Button type="submit" isLoading={addDomain.isPending}>
              <Trans>Add domain</Trans>
            </Button>
          </div>
          {addSuccess ? (
            <Alert tone="success">
              <Trans>
                Domain added. Create the DNS TXT record shown in the table to verify ownership.
              </Trans>
            </Alert>
          ) : null}
        </form>
      </ConsolePageSplitSection>

      <OrgCustomHostnames orgId={orgId} />
    </ConsolePage>
  )
}
