import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Alert, Badge, Button, EmptyState, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useCreateComplianceDocument,
  useDeleteComplianceDocument,
  usePlatformComplianceDocumentsQuery,
  useUpdateComplianceDocument,
} from './queries'
import type { ComplianceDocument } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
// These values demonstrate machine-readable identifiers and paths, so translating them would make
// the examples invalid.
const TECHNICAL_EXAMPLES = {
  documentType: 'dpa',
  version: '2026-07',
  storageKey: 'compliance/dpa/2026-07.pdf',
  checksum: 'sha256:...',
} as const

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  header: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
  },
  lead: {
    maxWidth: '54rem',
    margin: '0.5rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.55,
  },
  section: {
    paddingInline: GUTTER,
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionTitle: {
    margin: '0 0 1rem',
    color: tokens['--xid-fg'],
    fontSize: '1rem',
    fontWeight: 620,
  },
  form: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
    maxWidth: '60rem',
  },
  full: {
    gridColumn: '1 / -1',
  },
  select: {
    width: '100%',
    minHeight: '2.625rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.9375rem',
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
  message: {
    marginBottom: '1rem',
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

  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Compliance center</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Publish versioned evidence, retain DPA acceptance records, and serve verified artifacts
            from R2.
          </Trans>
        </p>
      </header>

      <section aria-labelledby="compliance-create" {...stylex.props(styles.section)}>
        <h2 id="compliance-create" {...stylex.props(styles.sectionTitle)}>
          <Trans>Register evidence</Trans>
        </h2>
        {create.isError ? (
          <div {...stylex.props(styles.message)}>
            <Alert tone="error">{create.error.message}</Alert>
          </div>
        ) : null}
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
            <select
              {...stylex.props(styles.select)}
              value={form.status}
              onChange={(event) =>
                setForm({ ...form, status: event.target.value as ComplianceDocument['status'] })
              }
            >
              <option value="draft">{t`Draft`}</option>
              <option value="available">{t`Available`}</option>
              <option value="retired">{t`Retired`}</option>
            </select>
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
      </section>

      <section aria-labelledby="compliance-ledger" {...stylex.props(styles.section)}>
        <h2 id="compliance-ledger" {...stylex.props(styles.sectionTitle)}>
          <Trans>Evidence ledger</Trans>
        </h2>
        {query.isLoading ? (
          <Spinner />
        ) : query.isError ? (
          <Alert tone="error">
            <Trans>Failed to load compliance documents.</Trans>
          </Alert>
        ) : !query.data?.data.length ? (
          <EmptyState title={<Trans>No compliance evidence registered.</Trans>} />
        ) : (
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
                  <div {...stylex.props(styles.actions)}>
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
                        >
                          {document.status === 'available' ? (
                            <Trans>Retire</Trans>
                          ) : (
                            <Trans>Publish</Trans>
                          )}
                        </Button>
                        <Button
                          variant="secondary"
                          isLoading={remove.isPending && remove.variables?.id === document.id}
                          onClick={() => {
                            if (
                              window.confirm(t`Delete compliance document "${document.title}"?`)
                            ) {
                              remove.mutate({ id: document.id })
                            }
                          }}
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
        )}
      </section>
    </div>
  )
}
