import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { ConfirmDialog } from '@xid-kit/web-ui'
import { useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import { Alert, Badge, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useCanManageOrg } from './useOrgTarget'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'
// 主机名语法各 locale 必须保持可原样提交,不可本地化占位符。
const HOSTNAME_EXAMPLE = 'login.example.com'

type DnsRecord = {
  type: string
  name: string
  value: string
}

type CustomHostname = {
  id: string
  organization_id: string
  hostname: string
  status: string
  hostname_status: string
  ssl_status: string | null
  ownership_expires_at: string | null
  activated_at: string | null
  last_polled_at: string | null
  requires_passkey_reregistration: boolean
  dns_records: {
    ownership: DnsRecord | null
    dcv_delegation: DnsRecord[]
    certificate_validation: DnsRecord[]
    traffic: DnsRecord
  }
  verification_errors: string[]
}

type CustomHostnamePage = {
  data: CustomHostname[]
  next_cursor: string | null
  has_more: boolean
}

type DeletedCustomHostname = {
  id: string
  status: 'deleted'
  remove_dns_record: DnsRecord
}

const styles = stylex.create({
  section: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  headingRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1rem',
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
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    maxWidth: '32rem',
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
    gap: '0.875rem',
    maxWidth: '42rem',
  },
  addRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '0.75rem',
  },
  inputWrap: {
    flex: '1 1 18rem',
    minWidth: 0,
  },
  list: {
    display: 'grid',
    gap: '0.875rem',
  },
  card: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    padding: 'clamp(1rem, 1.5vw, 1.5rem)',
    display: 'grid',
    gap: '1rem',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
    flexWrap: 'wrap',
  },
  hostname: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.9375rem',
    fontWeight: 600,
    wordBreak: 'break-all',
  },
  statusRow: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  recordGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 52rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '0.75rem',
  },
  record: {
    minWidth: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingTop: '0.75rem',
    display: 'grid',
    gap: '0.25rem',
  },
  recordLabel: {
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.75rem',
    lineHeight: 1.4,
  },
  recordCode: {
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    lineHeight: 1.5,
    wordBreak: 'break-all',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  empty: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
  },
  metaText: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.75rem',
    lineHeight: 1.5,
  },
})

function StatusBadge({ status }: { status: string }): ReactNode {
  if (status === 'active') {
    return (
      <Badge tone="success">
        <Trans>Active</Trans>
      </Badge>
    )
  }
  if (status === 'deletion_failed' || status === 'provisioning_failed') {
    return (
      <Badge tone="danger">
        <Trans>Action required</Trans>
      </Badge>
    )
  }
  return (
    <Badge tone="warning">
      <Trans>Pending DNS</Trans>
    </Badge>
  )
}

function DnsInstruction({ label, record }: { label: ReactNode; record: DnsRecord }): ReactNode {
  return (
    <div {...stylex.props(styles.record)}>
      <span {...stylex.props(styles.recordLabel)}>{label}</span>
      <code {...stylex.props(styles.recordCode)}>
        {record.type} {record.name}
      </code>
      <code {...stylex.props(styles.recordCode)}>{record.value}</code>
    </div>
  )
}

function DnsInstructions({ hostname }: { hostname: CustomHostname }): ReactNode {
  return (
    <div {...stylex.props(styles.recordGrid)}>
      {hostname.dns_records.ownership ? (
        <DnsInstruction
          label={<Trans>Hostname ownership</Trans>}
          record={hostname.dns_records.ownership}
        />
      ) : null}
      {hostname.dns_records.dcv_delegation.map((record) => (
        <DnsInstruction
          key={`${record.name}:${record.value}`}
          label={<Trans>Certificate validation</Trans>}
          record={record}
        />
      ))}
      {hostname.dns_records.certificate_validation.map((record) => (
        <DnsInstruction
          key={`${record.type}:${record.name}:${record.value}`}
          label={<Trans>Certificate validation</Trans>}
          record={record}
        />
      ))}
      <DnsInstruction
        label={<Trans>Traffic routing</Trans>}
        record={hostname.dns_records.traffic}
      />
    </div>
  )
}

export function OrgCustomHostnames({ orgId }: { orgId: string }): ReactNode {
  const { t } = useLingui()
  const canManage = useCanManageOrg(orgId)
  const queryKey = ['organizations', orgId, 'custom-hostnames'] as const
  const hostnamesQuery = useApiQuery<CustomHostnamePage>(
    queryKey,
    `/v1/organizations/${orgId}/custom-hostnames`,
    { enabled: canManage, query: { limit: 100 } },
  )
  const createHostname = useApiMutation<CustomHostname, { hostname: string }>(
    (api, payload) =>
      api.post<CustomHostname>(`/v1/organizations/${orgId}/custom-hostnames`, payload),
    { invalidate: [queryKey] },
  )
  const refreshHostname = useApiMutation<CustomHostname, string>(
    (api, id) =>
      api.post<CustomHostname>(`/v1/organizations/${orgId}/custom-hostnames/${id}/refresh`),
    { invalidate: [queryKey] },
  )
  const deleteHostname = useApiMutation<DeletedCustomHostname, string>(
    (api, id) =>
      api.del<DeletedCustomHostname>(`/v1/organizations/${orgId}/custom-hostnames/${id}`),
    { invalidate: [queryKey] },
  )

  const [hostname, setHostname] = useState('')
  const [lastCreated, setLastCreated] = useState<CustomHostname | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CustomHostname | null>(null)

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const normalized = hostname.trim()
    if (!normalized) return
    const created = await createHostname.mutateAsync({ hostname: normalized })
    setLastCreated(created)
    setHostname('')
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await deleteHostname.mutateAsync(pendingDelete.id)
    setPendingDelete(null)
    if (lastCreated?.id === pendingDelete.id) setLastCreated(null)
  }

  const actionError =
    createHostname.error?.message ?? refreshHostname.error?.message ?? deleteHostname.error?.message
  const hostnames = hostnamesQuery.data?.data ?? []

  return (
    <section aria-labelledby="custom-hostnames-heading" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.headingRow)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="custom-hostnames-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Custom sign-in hostnames</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDesc)}>
            <Trans>
              Use a customer-owned hostname for Hosted Auth. XID provisions the hostname and
              certificate through Cloudflare for SaaS, then activates routing only after both are
              ready.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controlCol)}>
          <Alert tone="warning">
            <Trans>
              A custom hostname changes the WebAuthn RP ID. Existing passkeys will not work on the
              new hostname, so users must register passkeys again there before you rely on it for
              sign-in.
            </Trans>
          </Alert>
          <form onSubmit={(event) => void handleCreate(event)} noValidate>
            <div {...stylex.props(styles.addRow)}>
              <div {...stylex.props(styles.inputWrap)}>
                <Field
                  label={<Trans>Custom hostname</Trans>}
                  error={createHostname.error?.message}
                  required
                >
                  <Input
                    value={hostname}
                    onChange={(event) => setHostname(event.target.value)}
                    placeholder={HOSTNAME_EXAMPLE}
                    autoComplete="off"
                    inputMode="url"
                    required
                  />
                </Field>
              </div>
              <Button type="submit" isLoading={createHostname.isPending}>
                <Trans>Add hostname</Trans>
              </Button>
            </div>
          </form>
        </div>
      </div>

      {lastCreated ? (
        <Alert tone="success">
          <Trans>
            Hostname reserved. Add every DNS record shown below. Ownership instructions expire if
            they are not completed in time.
          </Trans>
        </Alert>
      ) : null}

      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {hostnamesQuery.isLoading ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner />
        </div>
      ) : hostnamesQuery.isError ? (
        <Alert tone="error">
          <Trans>Failed to load custom hostnames. Please try again.</Trans>
        </Alert>
      ) : hostnames.length === 0 ? (
        <p {...stylex.props(styles.empty)}>
          <Trans>No custom sign-in hostnames added yet.</Trans>
        </p>
      ) : (
        <div {...stylex.props(styles.list)}>
          {hostnames.map((item) => (
            <article key={item.id} {...stylex.props(styles.card)}>
              <div {...stylex.props(styles.cardHeader)}>
                <div>
                  <h3 {...stylex.props(styles.hostname)}>{item.hostname}</h3>
                  <p {...stylex.props(styles.metaText)}>
                    <Trans>Hostname status:</Trans> {item.hostname_status}
                    {' / '}
                    <Trans>Certificate status:</Trans> {item.ssl_status ?? t`Waiting`}
                  </p>
                </div>
                <div {...stylex.props(styles.statusRow)}>
                  <StatusBadge status={item.status} />
                  {item.requires_passkey_reregistration ? (
                    <Badge tone="info">
                      <Trans>Passkey re-registration required</Trans>
                    </Badge>
                  ) : null}
                </div>
              </div>

              <DnsInstructions hostname={item} />

              {item.verification_errors.length > 0 ? (
                <Alert tone="warning">
                  <Trans>Cloudflare is still waiting for DNS verification.</Trans>
                </Alert>
              ) : null}

              <div {...stylex.props(styles.actions)}>
                <Button
                  variant="secondary"
                  isLoading={refreshHostname.isPending && refreshHostname.variables === item.id}
                  onClick={() => void refreshHostname.mutateAsync(item.id)}
                  aria-label={t`Refresh status for ${item.hostname}`}
                >
                  <Trans>Refresh status</Trans>
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setPendingDelete(item)}
                  aria-label={t`Delete custom hostname ${item.hostname}`}
                >
                  <Trans>Delete</Trans>
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete custom hostname?</Trans>}
          description={
            <Trans>
              XID will delete the Cloudflare custom hostname before marking it deleted locally.
              Remove the traffic CNAME after this succeeds.
            </Trans>
          }
          confirmLabel={<Trans>Delete hostname</Trans>}
          isLoading={deleteHostname.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </section>
  )
}
