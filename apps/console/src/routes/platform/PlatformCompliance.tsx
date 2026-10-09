import type { I18n } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Alert,
  Button,
  CopyButton,
  Dialog,
  Field,
  Icon,
  Input,
  KeyValueList,
} from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { queryKeyPrefixes } from '@xid-kit/web-ui/queries'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PlatformOrganizationPicker } from '../../components/PlatformOrganizationPicker'
import { useComplianceDocuments } from './ops-queries'
import type { PlatformComplianceDocument } from './ops-queries'
import {
  useCreateComplianceDocument,
  useDeleteComplianceDocument,
  useUpdateComplianceDocument,
} from './queries'

// 机器可读标识/路径示例,翻译会破坏可用性。
const TECHNICAL_EXAMPLES = {
  documentType: 'soc2',
  version: '2026',
  storageKey: 'compliance/soc2/2026.pdf',
  checksum: 'sha256:...',
} as const

const NARROW = '@media (max-width: 40rem)'

const styles = stylex.create({
  title: {
    display: 'block',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
  },
  sub: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  number: {
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  checksum: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    whiteSpace: 'nowrap',
  },
  matched: {
    display: 'block',
    color: tokens['--xid-success'],
    fontSize: text.base,
  },
  blocked: {
    display: 'block',
    color: tokens['--xid-danger'],
    fontSize: text.base,
    fontWeight: weight.medium,
  },
  never: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    lineHeight: 1.5,
  },
  code: {
    fontFamily: tokens['--xid-font-mono'],
  },
  form: {
    display: 'grid',
    gap: '1rem',
  },
  twoUp: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr 1fr', [NARROW]: '1fr' },
    gap: '1rem',
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
})

function shortChecksum(checksum: string): string {
  const [algorithm, digest = ''] = checksum.split(':')
  return digest.length > 12 ? `${algorithm}:${digest.slice(0, 4)}…${digest.slice(-4)}` : checksum
}

function formatBytes(i18n: I18n, bytes: number): string {
  if (bytes < 1024) return i18n.number(bytes, { style: 'unit', unit: 'byte' })
  if (bytes < 1024 * 1024) return `${i18n.number(bytes / 1024, { maximumFractionDigits: 0 })} KiB`
  return `${i18n.number(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MiB`
}

function shortDate(i18n: I18n, iso: string): string {
  return i18n.date(new Date(iso), { month: 'short', day: 'numeric' })
}

function DownloadCheck({ document }: { document: PlatformComplianceDocument }): ReactNode {
  const { i18n } = useLingui()
  if (!document.lastCheckedAt || !document.lastCheckResult) {
    return (
      <span {...stylex.props(styles.never)}>
        <Trans>Not downloaded yet</Trans>
      </span>
    )
  }
  const when = shortDate(i18n, document.lastCheckedAt)
  if (document.lastCheckResult === 'mismatch') {
    return (
      <>
        <span {...stylex.props(styles.blocked)}>
          <Trans>Blocked, {when}</Trans>
        </span>
        <span {...stylex.props(styles.sub)}>
          <Trans>Stored file no longer matches</Trans>
        </span>
      </>
    )
  }
  return (
    <span {...stylex.props(styles.matched)}>
      <Trans>Matched, {when}</Trans>
    </span>
  )
}

// 下载经 Core 重算校验和;不一致时 Core 拒绝并记录结果,列表随后刷新显示。
function useArtifactDownload(): {
  download: (document: PlatformComplianceDocument) => Promise<void>
  pendingId: string | null
  failedId: string | null
} {
  const queryClient = useQueryClient()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)

  async function download(document: PlatformComplianceDocument): Promise<void> {
    if (!document.artifactUrl) return
    setPendingId(document.id)
    setFailedId(null)
    try {
      const response = await fetch(document.artifactUrl, { credentials: 'include' })
      if (!response.ok) {
        setFailedId(document.id)
        return
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download =
        /filename="([^"]+)"/u.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
        `${document.documentType}-${document.version}`
      anchor.click()
      URL.revokeObjectURL(url)
    } finally {
      setPendingId(null)
      void queryClient.invalidateQueries({ queryKey: queryKeyPrefixes.platformComplianceDocuments })
    }
  }

  return { download, pendingId, failedId }
}

type RegisterForm = {
  tenantId: string
  documentType: string
  title: string
  version: string
  storageKey: string
  checksum: string
}

const EMPTY_FORM: RegisterForm = {
  tenantId: '',
  documentType: '',
  title: '',
  version: '',
  storageKey: '',
  checksum: '',
}

function RegisterEvidenceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const create = useCreateComplianceDocument()
  const [form, setForm] = useState<RegisterForm>(EMPTY_FORM)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate(
      {
        tenantId: form.tenantId || null,
        documentType: form.documentType,
        title: form.title,
        version: form.version,
        status: 'available',
        storageKey: form.storageKey,
        checksum: form.checksum,
      },
      {
        onSuccess: () => {
          setForm(EMPTY_FORM)
          onOpenChange(false)
        },
      },
    )
  }

  const storageKeyError =
    create.error?.meta?.paramName === 'storageKey' ? (
      <Trans>No object of 10 MiB or less exists at this key in private storage.</Trans>
    ) : undefined

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={<Trans>Register evidence</Trans>}
      description={
        <Trans>
          Upload the file under compliance/ first. Its checksum is checked before every download.
        </Trans>
      }
    >
      <form {...stylex.props(styles.form)} onSubmit={submit}>
        <Field label={t`Title`}>
          <Input
            required
            maxLength={160}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
        </Field>
        <div {...stylex.props(styles.twoUp)}>
          <Field label={t`Document type`}>
            <Input
              required
              value={form.documentType}
              placeholder={TECHNICAL_EXAMPLES.documentType}
              onChange={(event) => setForm({ ...form, documentType: event.target.value })}
            />
          </Field>
          <Field label={t`Version`}>
            <Input
              required
              value={form.version}
              placeholder={TECHNICAL_EXAMPLES.version}
              onChange={(event) => setForm({ ...form, version: event.target.value })}
            />
          </Field>
        </div>
        <Field label={t`Storage key`} error={storageKeyError}>
          <Input
            required
            spellCheck={false}
            value={form.storageKey}
            placeholder={TECHNICAL_EXAMPLES.storageKey}
            onChange={(event) => setForm({ ...form, storageKey: event.target.value })}
          />
        </Field>
        <Field label={t`SHA-256 checksum`}>
          <Input
            required
            spellCheck={false}
            value={form.checksum}
            placeholder={TECHNICAL_EXAMPLES.checksum}
            onChange={(event) => setForm({ ...form, checksum: event.target.value })}
          />
        </Field>
        <PlatformOrganizationPicker
          label={t`Shared with`}
          value={form.tenantId}
          onChange={(tenantId) => setForm({ ...form, tenantId })}
          emptyOption={t`All organizations`}
        />
        {create.error && !storageKeyError ? (
          <Alert tone="error">{errorMessage(create.error, { surface: 'general' })}</Alert>
        ) : null}
        <div {...stylex.props(styles.footer)}>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isLoading={create.isPending}>
            <Trans>Register evidence</Trans>
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function EvidenceDetails({
  document,
  onClose,
}: {
  document: PlatformComplianceDocument
  onClose: () => void
}): ReactNode {
  const { i18n, t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const update = useUpdateComplianceDocument()
  const remove = useDeleteComplianceDocument()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const editable = document.acceptedAt === null
  const items = [
    { key: 'storage', label: t`Storage key`, value: document.storageKey ?? '', isCode: true },
    { key: 'checksum', label: t`Checksum`, value: document.checksum ?? '', isCode: true },
    {
      key: 'shared',
      label: t`Shared with`,
      value:
        document.organizationName ?? (document.tenantId ? document.tenantId : t`All organizations`),
    },
    {
      key: 'check',
      label: t`Last download check`,
      value: <DownloadCheck document={document} />,
    },
    {
      key: 'registered',
      label: t`Registered`,
      value: i18n.date(new Date(document.createdAt), { dateStyle: 'medium' }),
    },
  ]
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={document.title}
      description={
        document.lastCheckResult === 'mismatch' ? (
          <Trans>
            The stored file no longer matches the checksum registered for it, so downloads are
            blocked. Register a new version with the correct file; this record stays as it is.
          </Trans>
        ) : undefined
      }
      footer={
        editable ? (
          <div {...stylex.props(styles.footer)}>
            <Button
              variant="secondary"
              isLoading={update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    id: document.id,
                    body: { status: document.status === 'available' ? 'retired' : 'available' },
                  },
                  { onSuccess: onClose },
                )
              }
            >
              {document.status === 'available' ? (
                <Trans>Retire</Trans>
              ) : (
                <Trans>Make available</Trans>
              )}
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trans>Delete…</Trans>
            </Button>
          </div>
        ) : undefined
      }
    >
      <KeyValueList items={items} />
      {update.error ? (
        <Alert tone="error">{errorMessage(update.error, { surface: 'general' })}</Alert>
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={<Trans>Delete this evidence record?</Trans>}
          description={
            <Trans>
              The record is removed. The stored file stays in private storage. Accepted evidence
              cannot be deleted.
            </Trans>
          }
          confirmLabel={<Trans>Delete record</Trans>}
          isLoading={remove.isPending}
          error={remove.error ? errorMessage(remove.error, { surface: 'general' }) : undefined}
          onConfirm={() => remove.mutate({ id: document.id }, { onSuccess: onClose })}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </Dialog>
  )
}

function useEvidenceColumns(input: {
  download: (document: PlatformComplianceDocument) => Promise<void>
  pendingId: string | null
  onDetails: (document: PlatformComplianceDocument) => void
}): ColumnDef<PlatformComplianceDocument>[] {
  const { i18n, t } = useLingui()
  const { download, pendingId, onDetails } = input
  return useMemo<ColumnDef<PlatformComplianceDocument>[]>(
    () => [
      {
        id: 'document',
        header: () => <Trans>Document</Trans>,
        cell: ({ row }) => (
          <>
            <span {...stylex.props(styles.title)}>{row.original.title}</span>
            <span {...stylex.props(styles.sub)}>{row.original.version}</span>
          </>
        ),
        meta: { priority: 'primary' },
      },
      {
        id: 'size',
        header: () => <Trans>Size</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.number)}>
            {row.original.sizeBytes === null ? null : formatBytes(i18n, row.original.sizeBytes)}
          </span>
        ),
        meta: { width: '6rem', align: 'end', priority: 'secondary' },
      },
      {
        id: 'checksum',
        header: () => <Trans>Checksum</Trans>,
        cell: ({ row }) =>
          row.original.checksum ? (
            <span {...stylex.props(styles.checksum)}>
              {shortChecksum(row.original.checksum)}
              <CopyButton value={row.original.checksum} subject={t`checksum`} />
            </span>
          ) : null,
        meta: { width: '13rem', priority: 'secondary' },
      },
      {
        id: 'registered',
        header: () => <Trans>Registered</Trans>,
        cell: ({ row }) => (
          <>
            <span {...stylex.props(styles.title)}>
              {i18n.date(new Date(row.original.createdAt), { dateStyle: 'medium' })}
            </span>
            <span {...stylex.props(styles.sub)}>{row.original.registeredBy}</span>
          </>
        ),
        meta: { width: '10rem', priority: 'secondary' },
      },
      {
        id: 'check',
        header: () => <Trans>Last download check</Trans>,
        cell: ({ row }) => <DownloadCheck document={row.original} />,
        meta: { width: '13rem' },
      },
      {
        id: 'action',
        header: () => null,
        cell: ({ row }) =>
          row.original.lastCheckResult === 'mismatch' || !row.original.artifactUrl ? (
            <Button variant="secondary" onClick={() => onDetails(row.original)}>
              <Trans>Details</Trans>
            </Button>
          ) : (
            <Button
              variant="secondary"
              aria-label={t`Download ${row.original.title}`}
              isLoading={pendingId === row.original.id}
              onClick={() => void download(row.original)}
            >
              <Trans>Download</Trans>
            </Button>
          ),
        meta: { width: '8rem', align: 'end' },
      },
    ],
    [i18n, t, download, pendingId, onDetails],
  )
}

export default function PlatformCompliance(): ReactNode {
  const documents = useComplianceDocuments()
  const { download, pendingId, failedId } = useArtifactDownload()
  const [registering, setRegistering] = useState(false)
  const [details, setDetails] = useState<PlatformComplianceDocument | null>(null)
  const columns = useEvidenceColumns({ download, pendingId, onDetails: setDetails })
  const rows = documents.data?.data ?? []
  const failed = rows.find((row) => row.id === failedId)

  return (
    <ConsolePage
      wide
      title={<Trans>Compliance evidence</Trans>}
      lead={
        <Trans>
          Reports and certificates you share with customers. Each one is a private object you
          register by its storage key and SHA-256 checksum; every download is checked against that
          checksum first.
        </Trans>
      }
      actions={
        <Button onClick={() => setRegistering(true)}>
          <Icon name="plus" />
          <Trans>Register evidence…</Trans>
        </Button>
      }
    >
      {documents.isError || failed ? (
        <ConsolePageNotice>
          {documents.isError ? (
            <Alert tone="error">
              <Trans>Compliance evidence could not be loaded.</Trans>{' '}
              <Button variant="secondary" onClick={() => void documents.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            </Alert>
          ) : null}
          {failed ? (
            <Alert tone="error">
              <Trans>
                {failed.title} was not downloaded. The stored file no longer matches its checksum or
                is unavailable.
              </Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={documents.isLoading}
          emptyMessage={
            <Trans>
              No evidence registered yet. Register a report once it is in private storage.
            </Trans>
          }
        />
        <LoadMore query={documents} loadMoreLabel={<Trans>Load more evidence</Trans>} />
        <p {...stylex.props(styles.note)}>
          <Trans>
            Objects are limited to 10 MiB and must already be in private storage under{' '}
            <span {...stylex.props(styles.code)}>compliance/</span>. To replace a document, register
            a new version; the old one stays for the record.
          </Trans>
        </p>
      </ConsolePageSection>

      <RegisterEvidenceDialog open={registering} onOpenChange={setRegistering} />
      {details ? <EvidenceDetails document={details} onClose={() => setDetails(null)} /> : null}
    </ConsolePage>
  )
}
