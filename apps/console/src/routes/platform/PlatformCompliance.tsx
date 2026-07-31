// platform console 合规中心:GET/POST/PATCH/DELETE /v1/platform/compliance-documents + cursor 分页。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + 5/7 双列登记表单 + hairline 分节列表。
// 删除走 ConfirmDialog(danger),mutation 错误走 ConsolePageNotice 固定本地化文案。

import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useCreateComplianceDocument,
  useDeleteComplianceDocument,
  usePlatformComplianceDocumentsQuery,
  useUpdateComplianceDocument,
} from './queries'
import type { ComplianceDocument } from './types'

// These values demonstrate machine-readable identifiers and paths, so translating them would make
// the examples invalid.
const TECHNICAL_EXAMPLES = {
  documentType: 'dpa',
  version: '2026-07',
  storageKey: 'compliance/dpa/2026-07.pdf',
  checksum: 'sha256:...',
} as const

const styles = stylex.create({
  form: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
  },
  full: {
    gridColumn: '1 / -1',
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.75rem',
    lineHeight: 1.55,
  },
  code: {
    fontFamily: tokens['--xid-font-mono'],
    color: tokens['--xid-fg'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.625rem',
    alignItems: 'center',
  },
  skeletonStack: {
    display: 'grid',
    gap: '0.75rem',
  },
  list: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 52rem)': 'minmax(0, 7fr) minmax(15rem, 5fr)',
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
  metadata: {
    margin: '0.625rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
  rowActions: {
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

type FormState = {
  tenantId: string
  documentType: string
  title: string
  version: string
  status: ComplianceDocument['status']
  storageKey: string
  checksum: string
}

const EMPTY_FORM: FormState = {
  tenantId: '',
  documentType: '',
  title: '',
  version: '',
  status: 'draft',
  storageKey: '',
  checksum: '',
}

function statusTone(status: ComplianceDocument['status']): 'neutral' | 'success' | 'warning' {
  if (status === 'available') return 'success'
  if (status === 'retired') return 'neutral'
  return 'warning'
}

function statusLabel(status: ComplianceDocument['status']): ReactNode {
  if (status === 'available') return <Trans>Available</Trans>
  if (status === 'retired') return <Trans>Retired</Trans>
  return <Trans>Draft</Trans>
}

export default function PlatformCompliance(): ReactNode {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<string | undefined>()
  const query = usePlatformComplianceDocumentsQuery(cursor)
  const create = useCreateComplianceDocument()
  const update = useUpdateComplianceDocument()
  const remove = useDeleteComplianceDocument()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<ComplianceDocument | null>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate(
      {
        tenantId: form.tenantId || null,
        documentType: form.documentType,
        title: form.title,
        version: form.version,
        status: form.status,
        storageKey: form.storageKey || null,
        checksum: form.checksum || null,
      },
      { onSuccess: () => setForm(EMPTY_FORM) },
    )
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await remove.mutateAsync({ id: pendingDelete.id })
    setPendingDelete(null)
  }

  return (
    <ConsolePage
      title={<Trans>Compliance center</Trans>}
      lead={
        <Trans>
          Publish versioned evidence, retain DPA acceptance records, and serve verified artifacts
          from R2.
        </Trans>
      }
    >
      {query.isError || create.isError || create.isSuccess || update.isError || remove.isError ? (
        <ConsolePageNotice>
          {query.isError ? (
            <Alert tone="error">
              <Trans>Failed to load compliance documents.</Trans>
            </Alert>
          ) : null}
          {create.isError ? (
            <Alert tone="error">
              <Trans>Failed to register the compliance document. Try again.</Trans>
            </Alert>
          ) : null}
          {create.isSuccess ? (
            <Alert tone="success">
              <Trans>Compliance document registered.</Trans>
            </Alert>
          ) : null}
          {update.isError ? (
            <Alert tone="error">
              <Trans>Failed to update the compliance document. Try again.</Trans>
            </Alert>
          ) : null}
          {remove.isError ? (
            <Alert tone="error">
              <Trans>Failed to delete the compliance document. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSplitSection
        title={<Trans>Register evidence</Trans>}
        description={
          <Trans>
            Register a versioned compliance artifact and control which tenants can download it.
          </Trans>
        }
      >
        <form {...stylex.props(styles.form)} onSubmit={submit}>
          <Field label={t`Document type`}>
            <Input
              required
              value={form.documentType}
              onChange={(event) => setForm({ ...form, documentType: event.target.value })}
              placeholder={TECHNICAL_EXAMPLES.documentType}
            />
          </Field>
          <Field label={t`Version`}>
            <Input
              required
              value={form.version}
              onChange={(event) => setForm({ ...form, version: event.target.value })}
              placeholder={TECHNICAL_EXAMPLES.version}
            />
          </Field>
          <Field label={t`Title`}>
            <Input
              required
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </Field>
          <Field label={t`Tenant ID`}>
            <Input
              value={form.tenantId}
              onChange={(event) => setForm({ ...form, tenantId: event.target.value })}
              placeholder={t`Leave empty for all tenants`}
            />
          </Field>
          <Field label={t`Publication state`}>
            <Select
              value={form.status}
              onChange={(event) =>
                setForm({ ...form, status: event.target.value as ComplianceDocument['status'] })
              }
            >
              <option value="draft">{t`Draft`}</option>
              <option value="available">{t`Available`}</option>
              <option value="retired">{t`Retired`}</option>
            </Select>
          </Field>
          <div />
          <Field label={t`R2 storage key`}>
            <Input
              value={form.storageKey}
              onChange={(event) => setForm({ ...form, storageKey: event.target.value })}
              placeholder={TECHNICAL_EXAMPLES.storageKey}
            />
          </Field>
          <Field label={t`SHA-256 checksum`}>
            <Input
              value={form.checksum}
              onChange={(event) => setForm({ ...form, checksum: event.target.value })}
              placeholder={TECHNICAL_EXAMPLES.checksum}
            />
          </Field>
          <div {...stylex.props(styles.full)}>
            <p {...stylex.props(styles.note)}>
              <Trans>
                Upload immutable artifacts under{' '}
                <code {...stylex.props(styles.code)}>compliance/</code> before publishing. The
                download route hashes every object and rejects a checksum mismatch.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.actions)}>
            <Button type="submit" isLoading={create.isPending}>
              <Trans>Register document</Trans>
            </Button>
          </div>
        </form>
      </ConsolePageSplitSection>

      <ConsolePageSection title={<Trans>Evidence ledger</Trans>}>
        {query.isLoading ? (
          <div {...stylex.props(styles.skeletonStack)}>
            <Skeleton height="6rem" />
            <Skeleton height="6rem" />
            <Skeleton height="6rem" />
          </div>
        ) : null}
        {!query.isLoading && query.data && query.data.data.length === 0 ? (
          <EmptyState title={<Trans>No compliance evidence registered.</Trans>} />
        ) : null}
        {query.data && query.data.data.length > 0 ? (
          <>
            <div {...stylex.props(styles.list)}>
              {query.data.data.map((document) => (
                <article key={document.id} {...stylex.props(styles.row)}>
                  <div>
                    <h3 {...stylex.props(styles.rowTitle)}>{document.title}</h3>
                    <div {...stylex.props(styles.meta)}>
                      <Badge tone={statusTone(document.status)}>
                        {statusLabel(document.status)}
                      </Badge>
                      <Badge tone="neutral">{document.documentType}</Badge>
                      <Badge tone="neutral">{document.version}</Badge>
                      {document.acceptedAt ? (
                        <Badge tone="success">
                          <Trans>Accepted</Trans>
                        </Badge>
                      ) : null}
                    </div>
                    <p {...stylex.props(styles.metadata)}>
                      {document.tenantId ?? t`All tenants`}
                      {document.checksum ? ` · ${document.checksum}` : ''}
                    </p>
                  </div>
                  <div {...stylex.props(styles.rowActions)}>
                    {document.artifactUrl ? (
                      <a
                        href={document.artifactUrl}
                        target="_blank"
                        rel="noopener"
                        {...stylex.props(styles.link)}
                      >
                        <Trans>Download artifact</Trans>
                      </a>
                    ) : null}
                    {!document.acceptedAt ? (
                      <>
                        <Button
                          variant="secondary"
                          isLoading={update.isPending && update.variables?.id === document.id}
                          onClick={() =>
                            update.mutate({
                              id: document.id,
                              body: {
                                status: document.status === 'available' ? 'retired' : 'available',
                              },
                            })
                          }
                          {...stylex.props(consoleShell.actionButton)}
                        >
                          {document.status === 'available' ? (
                            <Trans>Retire</Trans>
                          ) : (
                            <Trans>Publish</Trans>
                          )}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => setPendingDelete(document)}
                          aria-label={t`Delete compliance document ${document.title}`}
                          {...stylex.props(consoleShell.actionButton)}
                        >
                          <Trans>Delete</Trans>
                        </Button>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
            <Pagination
              nextCursor={query.data.nextCursor}
              loadMoreLabel={<Trans>Load more</Trans>}
              onLoadMore={setCursor}
            />
          </>
        ) : null}
      </ConsolePageSection>

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete compliance document?</Trans>}
          description={
            <Trans>
              The compliance document {pendingDelete.title} will be permanently deleted.
            </Trans>
          }
          confirmLabel={<Trans>Delete</Trans>}
          isLoading={remove.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
