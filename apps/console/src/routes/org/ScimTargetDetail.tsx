// 出站 SCIM 目标详情:最近一次运行与错误、目标配置与成员范围;手动同步入队后由最近运行显示结果。
// 目标表单字段与创建对话框共用,下游 token 只写不读。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Button,
  Dialog,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  Skeleton,
  useToast,
} from '@xid-kit/web-ui/ui'
import { frame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { formatDateTime } from '../../lib/date-format'
import {
  useDeleteScimTarget,
  useOrgScimTargetsQuery,
  useSyncScimTarget,
  useUpdateScimTarget,
} from './queries'
import { FailureReason, RunBadge, TargetRunBadge } from './ScimTargetRunState'
import type { AssignmentGate, CreateScimTargetInput, ScimTarget } from './types'
import { useOrgTarget } from './useOrgTarget'

export type TargetForm = {
  provider: string
  baseUrl: string
  token: string
  gateMode: AssignmentGate['mode']
  allowedRoles: string
  allowedUserIds: string
}

export const EMPTY_TARGET_FORM: TargetForm = {
  provider: '',
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

export function payloadFromForm(form: TargetForm): CreateScimTargetInput {
  const token = form.token.trim()
  const gate: AssignmentGate =
    form.gateMode === 'all'
      ? { mode: 'all', allowed_user_ids: [], allowed_roles: [] }
      : {
          mode: 'restricted',
          allowed_user_ids: parseCommaSeparated(form.allowedUserIds),
          allowed_roles: parseCommaSeparated(form.allowedRoles),
        }
  return {
    provider: form.provider.trim(),
    base_url: form.baseUrl.trim(),
    ...(token ? { token } : {}),
    assignment_gate: gate,
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

export function useTargetErrorMessage(): (error: XidError) => string {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  return (error) =>
    error.code === 'validation_failed' && error.meta?.paramName === 'token'
      ? t`Enter the downstream API token. Sync needs it, and changing the base URL host requires it again.`
      : errorMessage(error, { surface: 'general' })
}

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  layout: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 64rem)': 'minmax(0, 1fr) 21.25rem',
    },
    gap: { default: '1.5rem', '@media (min-width: 64rem)': '2.5rem' },
    alignItems: 'start',
  },
  section: { display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: 0 },
  sectionTitle: {
    margin: 0,
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.lg },
    lineHeight: { default: leading.md, '@media (min-width: 48rem)': leading.lg },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  muted: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
  },
  lead: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
  },
  runTable: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '12rem minmax(0, 1fr)' },
    columnGap: '1rem',
    margin: 0,
    fontSize: text.sm,
  },
  runHead: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    paddingBlock: '0.5rem',
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  runCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.5rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: { default: 0, '@media (min-width: 48rem)': '1px' },
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    lineHeight: leading.body,
  },
  runAt: { fontSize: text.base, fontVariantNumeric: 'tabular-nums' },
  asideHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  asideTitle: { margin: 0, fontSize: text.md, lineHeight: leading.md, fontWeight: weight.display },
  textAction: {
    appearance: 'none',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    cursor: 'pointer',
  },
  facts: { display: 'flex', flexDirection: 'column', gap: '0.75rem', margin: 0 },
  fact: { display: 'flex', flexDirection: 'column', gap: '0.125rem' },
  factLabel: { fontSize: text.xs, color: tokens['--xid-muted-foreground'] },
  factValue: { margin: 0, fontSize: text.sm, overflowWrap: 'anywhere' },
  mono: { fontFamily: tokens['--xid-font-mono'] },
  headActions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
})

export function TargetFormFields({
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
      <Field label={t`Service name`} required>
        <Input
          value={form.provider}
          onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))}
          placeholder={t`Fleet Planner`}
        />
      </Field>
      <Field label={t`SCIM endpoint`} required>
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
      <Field label={t`Members to push`}>
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
          <option value="restricted">{t`Only some roles or users`}</option>
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
              placeholder={t`admin, operations`}
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

export function TargetDialog({
  title,
  description,
  initial,
  isEdit,
  isPending,
  error,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: ReactNode
  description: ReactNode
  initial: TargetForm
  isEdit: boolean
  isPending: boolean
  error: XidError | null
  submitLabel: ReactNode
  onSubmit: (payload: CreateScimTargetInput) => void
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const targetErrorMessage = useTargetErrorMessage()
  const [form, setForm] = useState(initial)
  const [missing, setMissing] = useState(false)

  function submit(event: FormEvent): void {
    event.preventDefault()
    const incomplete = !form.provider.trim() || !form.baseUrl.trim()
    setMissing(incomplete)
    if (!incomplete) onSubmit(payloadFromForm(form))
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || isPending ? undefined : onClose())}
      title={title}
      description={description}
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form="scim-target-form" isLoading={isPending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="scim-target-form" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <TargetFormFields form={form} setForm={setForm} isEdit={isEdit} />
        {missing ? (
          <Alert tone="error">{t`Enter the service name and the SCIM endpoint.`}</Alert>
        ) : null}
        {error ? <Alert tone="error">{targetErrorMessage(error)}</Alert> : null}
      </form>
    </Dialog>
  )
}

function AssignmentText({ gate }: { gate: AssignmentGate }): ReactNode {
  if (gate.mode === 'all') return <Trans>All members</Trans>
  const roles = gate.allowed_roles.join(', ')
  const userCount = gate.allowed_user_ids.length
  if (roles && userCount > 0) {
    return (
      <Trans>
        Restricted roles: {roles}; {userCount} named users
      </Trans>
    )
  }
  if (roles) return <Trans>Restricted roles: {roles}</Trans>
  return <Trans>{userCount} named users</Trans>
}

function LastRun({ target }: { target: ScimTarget }): ReactNode {
  const { i18n } = useLingui()
  const runAt = formatDateTime(i18n, target.lastRunAt)
  const lastSync = formatDateTime(i18n, target.lastSyncAt)
  return (
    <section {...stylex.props(styles.section)}>
      <h2 {...stylex.props(styles.sectionTitle)}>
        <Trans>Last run</Trans>
      </h2>
      <p {...stylex.props(styles.muted)}>
        <Trans>XID keeps only the most recent run and its error.</Trans>
      </p>
      {runAt ? (
        <div {...stylex.props(styles.runTable)}>
          <span {...stylex.props(styles.runHead)}>
            <Trans>Run at</Trans>
          </span>
          <span {...stylex.props(styles.runHead)}>
            <Trans>Result</Trans>
          </span>
          <span {...stylex.props(styles.runCell, styles.runAt)}>{runAt}</span>
          <span {...stylex.props(styles.runCell)}>
            <RunBadge status={target.lastRunStatus} />
            <span>
              {target.lastRunError ? <FailureReason code={target.lastRunError} /> : null}{' '}
              {lastSync ? (
                <Trans>Last successful sync {lastSync}.</Trans>
              ) : (
                <Trans>No sync has succeeded yet.</Trans>
              )}
            </span>
          </span>
        </div>
      ) : (
        <p {...stylex.props(styles.muted)}>
          <Trans>
            No run yet. XID runs the first sync after the next member change, or when you sync now.
          </Trans>
        </p>
      )}
    </section>
  )
}

export default function ScimTargetDetail({
  targetId,
  listPath,
}: {
  targetId: string
  listPath: string
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const navigate = useNavigate()
  const targetErrorMessage = useTargetErrorMessage()
  const { orgId } = useOrgTarget()
  const targets = useOrgScimTargetsQuery(orgId)
  const update = useUpdateScimTarget(orgId)
  const remove = useDeleteScimTarget(orgId)
  const sync = useSyncScimTarget(orgId)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const target = targets.data?.find((row) => row.id === targetId) ?? null
  const provider = target?.provider ?? ''
  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      <li>
        <Link to={listPath} {...stylex.props(frame.crumbLink)}>
          <Trans>Provisioning</Trans>
        </Link>
      </li>
      <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
        /
      </li>
      <li aria-current="page">
        {target ? <Trans>{provider} SCIM</Trans> : <Skeleton width="6rem" height="0.75rem" />}
      </li>
    </ol>
  )

  if (targets.isError || (targets.data && !target)) {
    const missing = !targets.isError
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <EmptyState
          variant="load-failure"
          title={
            missing ? <Trans>Target not found</Trans> : <Trans>Target could not be loaded</Trans>
          }
          action={
            missing ? null : (
              <Button variant="secondary" onClick={() => void targets.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            )
          }
        />
      </div>
    )
  }
  if (!target) {
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <Skeleton width="16rem" height="2rem" />
      </div>
    )
  }

  const actionError = sync.error

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      <div {...stylex.props(detail.header)}>
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>
              <Trans>{provider} SCIM</Trans>
            </h1>
            <TargetRunBadge status={target.lastRunStatus} />
          </div>
          <p {...stylex.props(styles.lead)}>
            <Trans>
              XID pushes organization members to {provider} after members are removed or
              deactivated, and at least once a day.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.headActions)}>
          <Dropdown
            ariaLabel={t`Actions for ${provider}`}
            align="end"
            triggerStyle={list.filterButton}
            trigger={({ open }) => (
              <>
                <Trans>Actions</Trans>
                <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
              </>
            )}
            items={[
              { key: 'edit', label: <Trans>Edit target…</Trans>, onSelect: () => setEditing(true) },
              {
                key: 'delete',
                label: <Trans>Delete target…</Trans>,
                tone: 'danger' as const,
                separatorBefore: true,
                onSelect: () => setDeleting(true),
              },
            ]}
          />
          <Button
            disabled={!target.hasToken}
            isLoading={sync.isPending}
            onClick={() =>
              sync.mutate(target.id, {
                onSuccess: () => notify({ title: t`Sync queued. Last run shows the result.` }),
              })
            }
          >
            <Trans>Sync {provider}</Trans>
          </Button>
        </div>
      </div>
      {actionError ? <Alert tone="error">{targetErrorMessage(actionError)}</Alert> : null}
      {target.hasToken ? null : (
        <Alert tone="warning">
          <Trans>Add the downstream API token to enable sync.</Trans>
        </Alert>
      )}
      <div {...stylex.props(styles.layout)}>
        <LastRun target={target} />
        <aside {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.asideHead)}>
            <h2 {...stylex.props(styles.asideTitle)}>
              <Trans>Target</Trans>
            </h2>
            <button
              type="button"
              onClick={() => setEditing(true)}
              {...stylex.props(styles.textAction)}
            >
              <Trans>Edit…</Trans>
            </button>
          </div>
          <dl {...stylex.props(styles.facts)}>
            <div {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.factLabel)}>
                <Trans>SCIM endpoint</Trans>
              </dt>
              <dd {...stylex.props(styles.factValue, styles.mono)}>{target.baseUrl}</dd>
            </div>
            <div {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.factLabel)}>
                <Trans>API token</Trans>
              </dt>
              <dd {...stylex.props(styles.factValue)}>
                {target.hasToken ? <Trans>Configured</Trans> : <Trans>Missing</Trans>}
              </dd>
            </div>
            <div {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.factLabel)}>
                <Trans>Assignment</Trans>
              </dt>
              <dd {...stylex.props(styles.factValue)}>
                <AssignmentText gate={target.assignmentGate} />
              </dd>
            </div>
          </dl>
        </aside>
      </div>
      {editing ? (
        <TargetDialog
          title={<Trans>Edit {provider} target</Trans>}
          description={<Trans>Changes apply from the next sync.</Trans>}
          initial={formFromTarget(target)}
          isEdit
          isPending={update.isPending}
          error={update.error}
          submitLabel={<Trans>Save changes</Trans>}
          onSubmit={(payload) =>
            update.mutate({ targetId: target.id, payload }, { onSuccess: () => setEditing(false) })
          }
          onClose={() => setEditing(false)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={<Trans>Delete the {provider} target?</Trans>}
          description={
            <Trans>
              {provider} stops receiving member updates. Accounts XID already created there stay as
              they are.
            </Trans>
          }
          confirmLabel={<Trans>Delete target</Trans>}
          isLoading={remove.isPending}
          onConfirm={() =>
            remove.mutate(target.id, {
              onSuccess: () => {
                notify({ title: t`The ${provider} target was deleted` })
                navigate(listPath)
              },
              onSettled: () => setDeleting(false),
            })
          }
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </div>
  )
}
