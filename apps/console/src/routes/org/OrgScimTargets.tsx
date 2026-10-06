import { Trans, useLingui } from '@lingui/react/macro'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { Alert, Badge, Button, Field, Input, Select } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  useCreateScimTarget,
  useDeleteScimTarget,
  useOrgScimTargetsQuery,
  useSyncScimTarget,
  useUpdateScimTarget,
} from './queries'
import { ScimTargetRunState } from './ScimTargetRunState'
import type { AssignmentGate, CreateScimTargetInput, ScimTarget } from './types'
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
  token: string
  gateMode: AssignmentGate['mode']
  allowedRoles: string
  allowedUserIds: string
}

const EMPTY_FORM: TargetForm = {
  provider: 'slack',
  baseUrl: '',
  token: '',
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

function gateFromForm(form: TargetForm): AssignmentGate {
  if (form.gateMode === 'all') return { mode: 'all', allowed_user_ids: [], allowed_roles: [] }
  return {
    mode: 'restricted',
    allowed_user_ids: parseCommaSeparated(form.allowedUserIds),
    allowed_roles: parseCommaSeparated(form.allowedRoles),
  }
}

function payloadFromForm(form: TargetForm): CreateScimTargetInput {
  const token = form.token.trim()
  return {
    provider: form.provider.trim(),
    base_url: form.baseUrl.trim(),
    ...(token ? { token } : {}),
    assignment_gate: gateFromForm(form),
  }
}

function formFromTarget(target: ScimTarget): TargetForm {
  return {
    provider: target.provider,
    baseUrl: target.baseUrl,
    token: '',
    gateMode: target.assignmentGate.mode,
    allowedRoles: target.assignmentGate.allowed_roles.join(', '),
    allowedUserIds: target.assignmentGate.allowed_user_ids.join(', '),
  }
}

function TokenStatus({ hasToken }: { hasToken: boolean }): ReactNode {
  return hasToken ? (
    <Badge tone="success">
      <Trans>Configured</Trans>
    </Badge>
  ) : (
    <Badge tone="warning">
      <Trans>Missing</Trans>
    </Badge>
  )
}

const columns: ColumnDef<ScimTarget>[] = [
  {
    id: 'provider',
    header: () => <Trans>Provider</Trans>,
    cell: ({ row }) => row.original.provider,
  },
  { id: 'base', header: () => <Trans>Base URL</Trans>, cell: ({ row }) => row.original.baseUrl },
  {
    id: 'token',
    header: () => <Trans>API token</Trans>,
    cell: ({ row }) => <TokenStatus hasToken={row.original.hasToken} />,
  },
  {
    id: 'lastRun',
    header: () => <Trans>Last run</Trans>,
    cell: ({ row }) => <ScimTargetRunState target={row.original} />,
  },
  {
    id: 'sync',
    header: () => <Trans>Last successful sync</Trans>,
    cell: ({ row }) =>
      row.original.lastSyncAt ? new Date(row.original.lastSyncAt).toLocaleString() : '—',
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
  isEdit,
}: {
  form: TargetForm
  setForm: (updater: (current: TargetForm) => TargetForm) => void
  isEdit: boolean
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
      <Field
        label={t`API token`}
        hint={
          isEdit
            ? t`Leave blank to keep the current token. The token is never shown again after saving.`
            : t`The bearer token issued by the downstream app. It is stored encrypted and never shown again.`
        }
      >
        <Input
          type="password"
          autoComplete="off"
          value={form.token}
          onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))}
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

function useTargetErrorMessage(): (error: XidError) => string {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  return (error) =>
    error.code === 'validation_failed' && error.meta?.paramName === 'token'
      ? t`Enter the downstream API token. Sync needs it, and changing the base URL host requires it again.`
      : errorMessage(error, { surface: 'general' })
}

export default function OrgScimTargets(): ReactNode {
  const { t } = useLingui()
  const targetErrorMessage = useTargetErrorMessage()
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
    const target = await createTarget.mutateAsync(payloadFromForm(createForm))
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
    await updateTarget.mutateAsync({ targetId: selected.id, payload: payloadFromForm(editForm) })
    setEditForm((current) => ({ ...current, token: '' }))
    setMessage({ tone: 'success', text: t`SCIM target saved.` })
  }

  const onSync = async (targetId: string): Promise<void> => {
    setMessage(null)
    await syncTarget.mutateAsync(targetId)
    setMessage({
      tone: 'success',
      text: t`SCIM sync queued. The Last run column shows the result.`,
    })
  }

  const confirmDelete = async (): Promise<void> => {
    if (!selected) return
    await deleteTarget.mutateAsync(selected.id)
    setSelectedId(null)
    setPendingDelete(false)
    setMessage({ tone: 'success', text: t`SCIM target deleted.` })
  }

  const actionError: XidError | null =
    createTarget.error ?? updateTarget.error ?? deleteTarget.error ?? syncTarget.error ?? null

  return (
    <ConsolePage
      wide
      title={<Trans>SCIM targets</Trans>}
      lead={<Trans>Push organization users and groups to downstream SaaS SCIM APIs.</Trans>}
    >
      {message || actionError || targetsQuery.isError ? (
        <ConsolePageNotice>
          {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
          {actionError ? <Alert tone="error">{targetErrorMessage(actionError)}</Alert> : null}
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
          <Trans>
            Register a downstream SCIM API and choose which members are pushed. A sync runs after
            members are removed or deactivated and at least once a day; members no longer in the
            organization are deactivated downstream.
          </Trans>
        }
      >
        <form {...stylex.props(styles.form)} onSubmit={(event) => void onCreate(event)}>
          <TargetFormFields form={createForm} setForm={setCreateForm} isEdit={false} />
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
            <TargetFormFields form={editForm} setForm={setEditForm} isEdit />
            {selected.hasToken ? null : (
              <Alert tone="warning">
                <Trans>Add the downstream API token to enable sync.</Trans>
              </Alert>
            )}
            <div {...stylex.props(styles.targetActions)}>
              <Button type="submit" isLoading={updateTarget.isPending}>
                <Trans>Save changes</Trans>
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!selected.hasToken}
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
