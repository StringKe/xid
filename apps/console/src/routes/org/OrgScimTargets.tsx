// org 下游 SCIM target 页:向 SaaS 推送用户/组。GET/POST/PATCH /v1/organizations/:orgId/scim-targets。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ColumnDef } from '@tanstack/react-table'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useCreateScimTarget,
  useDeleteScimTarget,
  useOrgScimTargetsQuery,
  useSyncScimTarget,
  useUpdateScimTarget,
} from './queries'
import type { AssignmentGate, ScimTarget } from './types'
import { useOrgTarget } from './useOrgTarget'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    minWidth: 0,
    paddingInline: GUTTER,
    paddingBlock: 'clamp(1.75rem, 2vw, 3rem)',
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
  },
  meta: {
    margin: 0,
    fontSize: '0.875rem',
    color: tokens['--xid-muted-foreground'],
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  form: {
    display: 'grid',
    gap: '1rem',
    maxWidth: '36rem',
  },
  targetActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  select: {
    width: '100%',
    padding: '0.625rem 0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontSize: '0.9375rem',
  },
})

type TargetForm = {
  provider: string
  baseUrl: string
  gateMode: AssignmentGate['mode']
  allowedRoles: string
  allowedUserIds: string
}

const EMPTY_FORM: TargetForm = {
  provider: 'slack',
  baseUrl: '',
  gateMode: 'all',
  allowedRoles: '',
  allowedUserIds: '',
}

function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function gateFromForm(form: TargetForm): AssignmentGate | undefined {
  if (form.gateMode === 'all') return { mode: 'all', allowed_user_ids: [], allowed_roles: [] }
  return {
    mode: 'restricted',
    allowed_user_ids: parseCommaSeparated(form.allowedUserIds),
    allowed_roles: parseCommaSeparated(form.allowedRoles),
  }
}

function formFromTarget(target: ScimTarget): TargetForm {
  return {
    provider: target.provider,
    baseUrl: target.baseUrl,
    gateMode: target.assignmentGate.mode,
    allowedRoles: target.assignmentGate.allowed_roles.join(', '),
    allowedUserIds: target.assignmentGate.allowed_user_ids.join(', '),
  }
}

const columns: ColumnDef<ScimTarget>[] = [
  {
    id: 'provider',
    header: () => <Trans>Provider</Trans>,
    cell: ({ row }) => row.original.provider,
  },
  { id: 'base', header: () => <Trans>Base URL</Trans>, cell: ({ row }) => row.original.baseUrl },
  {
    id: 'sync',
    header: () => <Trans>Last sync</Trans>,
    cell: ({ row }) => row.original.lastSyncAt ?? '—',
  },
  {
    id: 'gate',
    header: () => <Trans>Assignment</Trans>,
    cell: ({ row }) =>
      row.original.assignmentGate.mode === 'restricted' ? (
        <Trans>Restricted roles</Trans>
      ) : (
        <Trans>All members</Trans>
      ),
  },
]

function TargetFormFields({
  form,
  setForm,
}: {
  form: TargetForm
  setForm: (updater: (current: TargetForm) => TargetForm) => void
}): ReactNode {
  const { t } = useLingui()

  return (
    <>
      <Field label={t`Provider`}>
        <Input
          value={form.provider}
          onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))}
        />
      </Field>
      <Field label={t`Base URL`}>
        <Input
          value={form.baseUrl}
          onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder="https://example.com/scim/v2"
        />
      </Field>
      <Field label={t`Assignment mode`}>
        <select
          {...stylex.props(styles.select)}
          value={form.gateMode}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              gateMode: event.target.value as AssignmentGate['mode'],
            }))
          }
        >
          <option value="all">{t`All members`}</option>
          <option value="restricted">{t`Restricted roles`}</option>
        </select>
      </Field>
      {form.gateMode === 'restricted' ? (
        <>
          <Field label={t`Allowed roles (comma-separated)`}>
            <Input
              value={form.allowedRoles}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowedRoles: event.target.value }))
              }
              placeholder={t`admin, owner`}
            />
          </Field>
          <Field label={t`Allowed user IDs (comma-separated)`}>
            <Input
              value={form.allowedUserIds}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowedUserIds: event.target.value }))
              }
              placeholder={t`user_abc, user_def`}
            />
          </Field>
        </>
      ) : null}
    </>
  )
}

export default function OrgScimTargets(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const targetsQuery = useOrgScimTargetsQuery(orgId)
  const createTarget = useCreateScimTarget(orgId)
  const updateTarget = useUpdateScimTarget(orgId)
  const deleteTarget = useDeleteScimTarget(orgId)
  const syncTarget = useSyncScimTarget(orgId)
  const [createForm, setCreateForm] = useState<TargetForm>(EMPTY_FORM)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<TargetForm>(EMPTY_FORM)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const targets = targetsQuery.data ?? []
  const selected = targets.find((target) => target.id === selectedId) ?? null

  useEffect(() => {
    if (selected) setEditForm(formFromTarget(selected))
  }, [selected])

  if (targetsQuery.isLoading) {
    return (
      <div {...stylex.props(styles.root)}>
        <Spinner size={28} />
      </div>
    )
  }

  if (targetsQuery.isError) {
    return (
      <div {...stylex.props(styles.root)}>
        <Alert tone="error">{targetsQuery.error.message}</Alert>
      </div>
    )
  }

  const onCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!createForm.baseUrl.trim()) {
      setMessage({ tone: 'error', text: t`Base URL is required.` })
      return
    }
    const target = await createTarget.mutateAsync({
      provider: createForm.provider.trim(),
      base_url: createForm.baseUrl.trim(),
      assignment_gate: gateFromForm(createForm),
    })
    setCreateForm(EMPTY_FORM)
    setSelectedId(target.id)
    setMessage({ tone: 'success', text: t`SCIM target created.` })
  }

  const onUpdate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selected) return
    if (!editForm.baseUrl.trim()) {
      setMessage({ tone: 'error', text: t`Base URL is required.` })
      return
    }
    const payload: {
      provider?: string
      base_url: string
      assignment_gate?: AssignmentGate
    } = {
      provider: editForm.provider.trim(),
      base_url: editForm.baseUrl.trim(),
      assignment_gate: gateFromForm(editForm),
    }
    await updateTarget.mutateAsync({ targetId: selected.id, payload })
    setMessage({ tone: 'success', text: t`SCIM target saved.` })
  }

  const onSync = async (targetId: string): Promise<void> => {
    await syncTarget.mutateAsync(targetId)
    setMessage({
      tone: 'success',
      text: t`SCIM sync queued.`,
    })
  }

  const onDelete = async (): Promise<void> => {
    if (!selected) return
    await deleteTarget.mutateAsync(selected.id)
    setSelectedId(null)
    setMessage({ tone: 'success', text: t`SCIM target deleted.` })
  }

  const actionError =
    createTarget.error?.message ||
    updateTarget.error?.message ||
    deleteTarget.error?.message ||
    syncTarget.error?.message ||
    null

  return (
    <div {...stylex.props(styles.root)}>
      <div>
        <h1 {...stylex.props(styles.title)}>
          <Trans>SCIM targets</Trans>
        </h1>
        <p {...stylex.props(styles.meta)}>
          <Trans>Push organization users and groups to downstream SaaS SCIM APIs.</Trans>
        </p>
      </div>

      {message || actionError ? (
        <Alert tone={message?.tone ?? 'error'}>{message?.text ?? actionError}</Alert>
      ) : null}

      <section {...stylex.props(styles.section)}>
        <DataTable
          columns={columns}
          data={targets}
          getRowId={(row) => row.id}
          emptyMessage={<Trans>No SCIM targets configured.</Trans>}
          onRowClick={(row) => setSelectedId(row.id)}
        />
      </section>

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(page.sectionLabel)}>
          <Trans>Add SCIM target</Trans>
        </h2>
        <form {...stylex.props(styles.form)} onSubmit={onCreate}>
          <TargetFormFields form={createForm} setForm={setCreateForm} />
          <Button type="submit" disabled={createTarget.isPending}>
            {createTarget.isPending ? <Trans>Creating…</Trans> : <Trans>Add SCIM target</Trans>}
          </Button>
        </form>
      </section>

      {selected ? (
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(page.sectionLabel)}>
            <Trans>Edit SCIM target</Trans>
          </h2>
          <form {...stylex.props(styles.form)} onSubmit={onUpdate}>
            <TargetFormFields form={editForm} setForm={setEditForm} />
            <Field label={t`Token secret ref`}>
              <code>{selected.requiredTokenSecretName}</code>
            </Field>
            <div {...stylex.props(styles.targetActions)}>
              <Button type="submit" disabled={updateTarget.isPending}>
                {updateTarget.isPending ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
              </Button>
              <Button
                type="button"
                onClick={() => void onSync(selected.id)}
                disabled={syncTarget.isPending}
              >
                <Trans>Sync {selected.provider}</Trans>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void onDelete()}
                disabled={deleteTarget.isPending}
              >
                <Trans>Delete</Trans>
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  )
}
