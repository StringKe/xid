// org 域名验证页:域名列表(DNS TXT 验证状态 + enrollment mode)。
// 调 GET /v1/organizations/:orgId/domains;添加域名 POST(useMutation)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useOrgDomainsQuery } from './queries'
import { useApiMutation } from '@xid-kit/web-ui/queries'
import type { OrgDomain } from './types'
import { useOrgTarget } from './useOrgTarget'

// 全宽规范常量
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  tableSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  // 添加区:5/7 双列
  addSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 64rem)': '0',
    },
  },
  sectionMeta: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  sectionDesc: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    maxWidth: '28rem',
  },
  controlCol: {
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
  },
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
  addSuccessWrap: {
    marginTop: '0.75rem',
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
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Organization domains</Trans>
        </h1>
      </div>

      <section aria-labelledby="domains-list-heading" {...stylex.props(styles.tableSection)}>
        <h2 id="domains-list-heading" {...stylex.props(page.visuallyHidden)}>
          <Trans>Domain list</Trans>
        </h2>
        {isLoading ? (
          <div {...stylex.props(page.loadingCenter)}>
            <Spinner />
          </div>
        ) : isError ? (
          <Alert tone="error">
            <Trans>Failed to load domains. Please try again.</Trans>
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            data={data ?? []}
            getRowId={(row) => row.id}
            emptyMessage={<Trans>No domains added yet.</Trans>}
          />
        )}
      </section>

      <section aria-labelledby="domain-add-heading" {...stylex.props(styles.addSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="domain-add-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Add domain</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              Add an email domain to enable automatic org enrollment. After adding, you must verify
              ownership by adding the DNS TXT record shown in the table.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
          <form onSubmit={(e) => void handleAdd(e)} noValidate>
            <div {...stylex.props(styles.addRow)}>
              <div {...stylex.props(styles.addInputWrap)}>
                <Field
                  label={<Trans>Domain</Trans>}
                  error={addDomain.error?.message ?? undefined}
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
              <div {...stylex.props(styles.addSuccessWrap)}>
                <Alert tone="success">
                  <Trans>
                    Domain added. Add the DNS TXT record shown below to verify ownership.
                  </Trans>
                </Alert>
              </div>
            ) : null}
          </form>
        </div>
      </section>
    </div>
  )
}
