// org 域名验证页:域名列表(DNS TXT 验证状态 + enrollment mode)。
// 调 GET /v1/organizations/:orgId/domains;添加域名 POST(useMutation)。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;添加表单 5/7 双列(SplitSection)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgDomainsQuery } from './queries'
import { useApiMutation } from '@xid-kit/web-ui/queries'
import type { OrgDomain } from './types'
import { useOrgTarget } from './useOrgTarget'
import { OrgCustomHostnames } from './OrgCustomHostnames'

const styles = stylex.create({
  addRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
  },
  addInputWrap: {
    flex: '1 1 200px',
    minWidth: 0,
  },
  tokenCode: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    wordBreak: 'break-all',
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
  if (row.verificationToken && !row.verified) {
    return <code {...stylex.props(styles.tokenCode)}>{row.verificationToken}</code>
  }
  if (row.verified && row.verifiedAt) {
    return (
      <span {...stylex.props(styles.mutedSmall)}>
        {new Date(row.verifiedAt).toLocaleDateString()}
      </span>
    )
  }
  return null
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
    cell: ({ row }) => <VerifiedBadge verified={row.original.verified} />,
    meta: { width: '160px' },
  },
  {
    id: 'enrollment',
    header: () => <Trans>Enrollment mode</Trans>,
    cell: ({ row }) =>
      row.original.enrollmentMode === 'automatic' ? (
        <Trans>Automatic</Trans>
      ) : (
        <Trans>Invite required</Trans>
      ),
    meta: { width: '140px' },
  },
  {
    id: 'token',
    header: () => <Trans>TXT record</Trans>,
    cell: ({ row }) => <TxtRecord row={row.original} />,
  },
]

export default function OrgDomains(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgDomainsQuery(orgId)

  const [newDomain, setNewDomain] = useState('')
  const [addSuccess, setAddSuccess] = useState(false)

  const addDomain = useApiMutation<OrgDomain, { domain: string }>(
    (api, payload) => api.post<OrgDomain>(`/v1/organizations/${orgId}/domains`, payload),
    { invalidate: [['organizations', orgId, 'domains']] },
  )

  async function handleAdd(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!orgId || !newDomain.trim()) return
    setAddSuccess(false)
    await addDomain.mutateAsync({ domain: newDomain.trim() })
    setAddSuccess(true)
    setNewDomain('')
  }

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Domains</Trans>}>
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
      title={<Trans>Domains</Trans>}
      lead={
        <Trans>
          Verify email domains for enrollment and routing. Domain removal and re-verification are
          managed through the Management API.
        </Trans>
      }
    >
      {isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load domains.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Domain list</Trans>}>
        <DataTable
          columns={columns}
          data={data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No domains added yet.</Trans>}
        />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Add domain</Trans>}
        description={
          <Trans>
            Add an email domain to enable automatic org enrollment. After adding, you must verify
            ownership by adding the DNS TXT record shown in the table.
          </Trans>
        }
      >
        <form onSubmit={(e) => void handleAdd(e)} noValidate>
          <div {...stylex.props(styles.addRow)}>
            <div {...stylex.props(styles.addInputWrap)}>
              <Field
                label={<Trans>Domain</Trans>}
                error={addDomain.isError ? t`Failed to add domain. Try again.` : undefined}
                required
              >
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
                Domain added. Add the DNS TXT record shown in the table to verify ownership.
              </Trans>
            </Alert>
          ) : null}
        </form>
      </ConsolePageSplitSection>

      <OrgCustomHostnames orgId={orgId} />
    </ConsolePage>
  )
}
