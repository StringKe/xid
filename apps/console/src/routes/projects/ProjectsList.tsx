// 项目列表:一个项目里的应用共用一套角色与权限。检索、显示已删除、创建;已删除的项目行内恢复。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Badge,
  Button,
  CheckboxField,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IdentityCell,
  Input,
  Textarea,
  useToast,
} from '@xid-kit/web-ui/ui'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { ORG_PROJECTS_PATH } from '../../nav'
import { useCreateProject, useProjectsQuery, useRestoreProject } from '../org/queries'
import type { Project } from '../org/types'
import { useOrgTarget } from '../org/useOrgTarget'
import { useApplications } from '../applications/app-api'
import { kindLabel } from '../applications/app-format'
import { formatDate } from '../users/user-format'
import { withOrgId } from '../users/UsersList'

function CreateProjectDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string
  onClose: () => void
  onCreated: (project: Project) => void
}): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const create = useCreateProject(orgId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  function submit(event: FormEvent): void {
    event.preventDefault()
    create.mutate(
      { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
      { onSuccess: onCreated },
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Create project</Trans>}
      description={
        <Trans>A project holds applications that share one set of roles and permissions.</Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            form="create-project-form"
            disabled={!name.trim()}
            isLoading={create.isPending}
          >
            <Trans>Create project</Trans>
          </Button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={submit} noValidate {...stylex.props(list.cellStack)}>
        <Field label={<Trans>Name</Trans>}>
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={256}
          />
        </Field>
        <Field label={<Trans>Description</Trans>}>
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </Field>
        {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
      </form>
    </Dialog>
  )
}

export default function ProjectsList(): ReactNode {
  const { t, i18n } = useLingui()
  const { notify } = useToast()
  const { orgId } = useOrgTarget()
  const { activeOrg } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const errorMessage = useManagementErrorMessage()
  const [query, setQuery] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [creating, setCreating] = useState(false)
  const active = useProjectsQuery(orgId, 'active')
  const deleted = useProjectsQuery(showDeleted ? orgId : '', 'deleted')
  const restore = useRestoreProject(orgId)
  const tenantAdmin = activeOrg?.parentOrgId === null
  const apps = useApplications({ enabled: tenantAdmin })
  const appsByProject = new Map<string, string[]>()
  const kindsByProject = new Map<string, Set<string>>()
  if (tenantAdmin) {
    for (const app of apps.data?.data ?? []) {
      if (!app.project_id) continue
      appsByProject.set(app.project_id, [...(appsByProject.get(app.project_id) ?? []), app.name])
      kindsByProject.set(
        app.project_id,
        (kindsByProject.get(app.project_id) ?? new Set()).add(kindLabel(i18n, app)),
      )
    }
  }
  const needle = query.trim().toLowerCase()
  const rows = [
    ...(active.data?.data ?? []),
    ...(showDeleted ? (deleted.data?.data ?? []) : []),
  ].filter(
    (project) =>
      needle === '' ||
      project.name.toLowerCase().includes(needle) ||
      project.id.toLowerCase().includes(needle),
  )
  const open = (project: Pick<Project, 'id'>) =>
    navigate(withOrgId(`${ORG_PROJECTS_PATH}/${project.id}`, location.search))
  const activeCount = active.data?.data.length ?? 0
  const deletedCount = deleted.data?.data.length ?? 0

  const columns: DataTableColumnDef<Project>[] = [
    {
      id: 'project',
      header: () => t`Project`,
      cell: ({ row }) => (
        <span {...stylex.props(list.cellStack)}>
          <IdentityCell
            name={
              <>
                {row.original.name}{' '}
                {row.original.status === 'deleted' ? (
                  <Badge tone="neutral">
                    <Trans>Deleted</Trans>
                  </Badge>
                ) : null}
              </>
            }
            secondary={row.original.id}
            secondaryIsCode
          />
        </span>
      ),
      meta: { priority: 'primary', width: '30%' },
    },
    ...(tenantAdmin
      ? [
          {
            id: 'apps',
            header: () => t`Applications`,
            cell: ({ row }: { row: { original: Project } }) => {
              const names = appsByProject.get(row.original.id) ?? []
              return names.length === 0 ? (
                <span {...stylex.props(list.muted)}>{t`No applications`}</span>
              ) : (
                <span {...stylex.props(list.cellStack)}>
                  <span>{names.join(', ')}</span>
                  <span {...stylex.props(list.cellSub)}>
                    {[...(kindsByProject.get(row.original.id) ?? [])].join(', ')}
                  </span>
                </span>
              )
            },
            meta: { hidden: { narrow: true, regular: false } },
          } satisfies DataTableColumnDef<Project>,
        ]
      : []),
    {
      id: 'updated',
      header: () => t`Updated`,
      cell: ({ row }) =>
        row.original.status === 'deleted' ? (
          <Button
            variant="secondary"
            isLoading={restore.isPending && restore.variables === row.original.id}
            onClick={(event) => {
              event.stopPropagation()
              restore.mutate(row.original.id, {
                onSuccess: () => notify({ title: t`Project restored` }),
              })
            }}
          >
            <Trans>Restore</Trans>
          </Button>
        ) : (
          <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.updated_at)}</span>
        ),
      meta: { align: 'end', priority: 'primary' },
    },
  ]

  return (
    <PageFrame
      title={<Trans>Projects</Trans>}
      lead={
        <Trans>A project holds applications that share one set of roles and permissions.</Trans>
      }
    >
      <div {...stylex.props(list.bar)}>
        <label {...stylex.props(list.search)}>
          <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
            <Icon name="search" size={16} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t`Project name or ID`}
            aria-label={t`Search projects`}
            {...stylex.props(list.searchInput)}
          />
        </label>
        <CheckboxField
          checked={showDeleted}
          onCheckedChange={setShowDeleted}
          label={<Trans>Show deleted</Trans>}
        />
        <div {...stylex.props(list.barEnd)}>
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            <Trans>Create project…</Trans>
          </Button>
        </div>
      </div>
      {active.data ? (
        <div {...stylex.props(list.summaryRow)}>
          <span {...stylex.props(list.summary)}>
            <Plural value={activeCount} one="# project" other="# projects" />
            {showDeleted ? (
              <>
                {', '}
                <Trans>{deletedCount} deleted</Trans>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {restore.error ? <Alert tone="error">{errorMessage(restore.error)}</Alert> : null}
      {active.isError && !active.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Projects could not be loaded</Trans>}
          action={
            <Button variant="secondary" onClick={() => void active.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : active.data && activeCount === 0 && !showDeleted ? (
        <EmptyState
          variant="first-use"
          title={<Trans>No projects yet</Trans>}
          description={
            <Trans>
              Create a project for each product, then add its applications, roles and permissions.
              Roles stay unique inside a project.
            </Trans>
          }
          action={
            <Button onClick={() => setCreating(true)}>
              <Trans>Create project…</Trans>
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={active.isLoading}
          onRowClick={(row) => (row.status === 'active' ? open(row) : undefined)}
          density="comfortable"
          narrowMode="priority"
          caption={t`Projects`}
          emptyMessage={<Trans>No projects match.</Trans>}
        />
      )}
      {creating ? (
        <CreateProjectDialog
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false)
            open(project)
          }}
        />
      ) : null}
    </PageFrame>
  )
}
