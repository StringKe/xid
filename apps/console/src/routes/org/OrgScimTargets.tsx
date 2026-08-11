// org 下游 SCIM target 页:向 SaaS 推送用户/组。GET/POST/PATCH /v1/organizations/:orgId/scim-targets。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;创建/编辑表单 5/7 双列(SplitSection)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Select } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  useCreateScimTarget,
  useDeleteScimTarget,
  useOrgScimTargetsQuery,
  useSyncScimTarget,
  useUpdateScimTarget,
} from './queries'
import type { AssignmentGate, ScimTarget } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
  form: {
    display: 'grid',
    gap: '1rem',
  },
  targetActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
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
          placeholder={t`https://example.com/scim/v2`}
        />
      </Field>
      <Field label={t`Assignment mode`}>
        <Select
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
        </Select>
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
  const [pendingDelete, setPendingDelete] = useState(false)

  const targets = targetsQuery.data ?? []
  const selected = targets.find((target) => target.id === selectedId) ?? null

  useEffect(() => {
    if (selected) setEditForm(formFromTarget(selected))
  }, [selected])

  const onCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setMessage(null)
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
    setMessage(null)
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
    setMessage(null)
    await syncTarget.mutateAsync(targetId)
    setMessage({
      tone: 'success',
      text: t`SCIM sync queued.`,
    })
  }

  const confirmDelete = async (): Promise<void> => {
    if (!selected) return
    await deleteTarget.mutateAsync(selected.id)
    setSelectedId(null)
    setPendingDelete(false)
    setMessage({ tone: 'success', text: t`SCIM target deleted.` })
  }

  const actionError =
    createTarget.isError || updateTarget.isError || deleteTarget.isError || syncTarget.isError

  return (
    <ConsolePage
      title={<Trans>SCIM targets</Trans>}
      lead={<Trans>Push organization users and groups to downstream SaaS SCIM APIs.</Trans>}
    >
      {message || actionError || targetsQuery.isError ? (
        <ConsolePageNotice>
          {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
          {actionError ? (
            <Alert tone="error">
              <Trans>Failed to save SCIM target changes. Try again.</Trans>
            </Alert>
          ) : null}
          {targetsQuery.isError ? (
            <Alert tone="error">
              <Trans>Failed to load SCIM targets.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Targets</Trans>}>
        <DataTable
          columns={columns}
          data={targets}
          getRowId={(row) => row.id}
          isLoading={targetsQuery.isLoading}
          emptyMessage={<Trans>No SCIM targets configured.</Trans>}
          onRowClick={(row) => setSelectedId(row.id)}
          isRowSelected={(row) => row.id === selectedId}
        />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Add SCIM target</Trans>}
        description={
          <Trans>Register a downstream SCIM API and choose which members are pushed.</Trans>
        }
      >
        <form {...stylex.props(styles.form)} onSubmit={(event) => void onCreate(event)}>
          <TargetFormFields form={createForm} setForm={setCreateForm} />
          <div>
            <Button type="submit" isLoading={createTarget.isPending}>
              <Trans>Add SCIM target</Trans>
            </Button>
          </div>
        </form>
      </ConsolePageSplitSection>

      {selected ? (
        <ConsolePageSplitSection
          title={<Trans>Edit SCIM target</Trans>}
          meta={<p {...stylex.props(consoleShell.selectorSummary)}>{selected.provider}</p>}
        >
          <form {...stylex.props(styles.form)} onSubmit={(event) => void onUpdate(event)}>
            <TargetFormFields form={editForm} setForm={setEditForm} />
            <Field label={t`Token secret ref`}>
              <code {...stylex.props(consoleShell.mono)}>{selected.requiredTokenSecretName}</code>
            </Field>
            <div {...stylex.props(styles.targetActions)}>
              <Button type="submit" isLoading={updateTarget.isPending}>
                <Trans>Save changes</Trans>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void onSync(selected.id)}
                isLoading={syncTarget.isPending}
              >
                <Trans>Sync {selected.provider}</Trans>
              </Button>
              <Button type="button" variant="danger" onClick={() => setPendingDelete(true)}>
                <Trans>Delete</Trans>
              </Button>
            </div>
          </form>
        </ConsolePageSplitSection>
      ) : null}

      {pendingDelete && selected ? (
        <ConfirmDialog
          title={<Trans>Delete SCIM target?</Trans>}
          description={
            <Trans>
              {selected.provider} ({selected.baseUrl}) will stop receiving user and group updates.
              This cannot be undone.
            </Trans>
          }
          confirmLabel={<Trans>Delete</Trans>}
          isLoading={deleteTarget.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(false)}
        />
      ) : null}
    </ConsolePage>
  )
}
