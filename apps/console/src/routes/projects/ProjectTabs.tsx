// 项目详情的 Applications、Managers、Settings 标签。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tenantManagerRoleForScope } from '@xid-kit/types'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Button,
  CopyField,
  Dialog,
  Field,
  Icon,
  Input,
  Textarea,
  useToast,
} from '@xid-kit/web-ui/ui'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { ORG_APPLICATIONS_PATH, ORG_PROJECTS_PATH } from '../../nav'
import {
  useCreateManagerAssignment,
  useDeleteManagerAssignment,
  useManagerAssignmentsQuery,
} from '../org/queries'
import type { CreatedApp } from '../applications/app-api'
import { useApplications } from '../applications/app-api'
import { AppsTable } from '../applications/AppsTable'
import { CreateApplicationDialog } from '../applications/CreateApplicationDialog'
import { SecretRevealDialog } from '../applications/SecretDialogs'
import { formatDate } from '../users/user-format'
import { withOrgId } from '../users/UsersList'
import type { ProjectRecord } from './project-api'
import { useProjectLifecycle, useUpdateProjectRecord } from './project-api'

export function ProjectAppsTab({
  project,
  canManage,
}: {
  project: ProjectRecord
  canManage: boolean
}): ReactNode {
  const location = useLocation()
  const navigate = useNavigate()
  const apps = useApplications({ projectId: project.id })
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedApp | null>(null)
  const open = (id: string) =>
    navigate(withOrgId(`${ORG_APPLICATIONS_PATH}/${id}`, location.search))
  const names = new Map([[project.id, project.name]])
  return (
    <>
      <div {...stylex.props(list.bar)}>
        <div {...stylex.props(list.barEnd)}>
          {canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} />
              <Trans>Create application…</Trans>
            </Button>
          ) : null}
        </div>
      </div>
      <AppsTable
        apps={apps.data?.data ?? []}
        isLoading={apps.isLoading}
        projectNames={names}
        showProject={false}
        onOpen={(app) => open(app.id)}
        emptyMessage={<Trans>No applications in this project yet.</Trans>}
      />
      {creating ? (
        <CreateApplicationDialog
          projects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          requireProject
          onClose={() => setCreating(false)}
          onCreated={(app) => {
            setCreating(false)
            if (app.client_secret) setCreated(app)
            else open(app.id)
          }}
        />
      ) : null}
      {created?.client_secret ? (
        <SecretRevealDialog
          appName={created.name}
          secret={created.client_secret}
          rotated={false}
          onDone={() => {
            const id = created.id
            setCreated(null)
            open(id)
          }}
        />
      ) : null}
    </>
  )
}

export function ProjectManagersTab({
  project,
  canManage,
}: {
  project: ProjectRecord
  canManage: boolean
}): ReactNode {
  const { t, i18n } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const assignments = useManagerAssignmentsQuery('project', project.id)
  const create = useCreateManagerAssignment('project', project.id)
  const remove = useDeleteManagerAssignment('project', project.id)
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const name = project.name
  return (
    <section {...stylex.props(detail.section)}>
      <div {...stylex.props(detail.sectionHead)}>
        <div {...stylex.props(detail.sectionText)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Trans>People who manage {name}</Trans>
          </h2>
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>
              They see only {name} in the Console. Managing a project never makes someone an admin
              of the organization. Organization owners and admins already manage every project.
            </Trans>
          </p>
        </div>
        {canManage ? (
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            <Trans>Add a manager…</Trans>
          </Button>
        ) : null}
      </div>
      {remove.error ? <Alert tone="error">{errorMessage(remove.error)}</Alert> : null}
      <ul {...stylex.props(detail.rows)}>
        {(assignments.data?.data ?? []).map((assignment) => {
          const since = formatDate(i18n, assignment.created_at)
          return (
            <li key={assignment.id} {...stylex.props(detail.itemRow)}>
              <div {...stylex.props(detail.itemMain)}>
                <span {...stylex.props(list.mono)}>{assignment.user_id}</span>
                <span {...stylex.props(detail.itemSub)}>
                  <Trans>
                    Manages all of {name} since {since}
                  </Trans>
                </span>
              </div>
              <span {...stylex.props(detail.itemAction)}>
                {canManage ? (
                  <Button
                    variant="secondary"
                    isLoading={remove.isPending && remove.variables === assignment.id}
                    onClick={() => remove.mutate(assignment.id)}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
      {assignments.data && assignments.data.data.length === 0 ? (
        <p {...stylex.props(detail.sectionLead)}>
          <Trans>No project managers yet.</Trans>
        </p>
      ) : null}
      {adding ? (
        <Dialog
          open
          onOpenChange={(next) => (next || create.isPending ? undefined : setAdding(false))}
          title={<Trans>Add a manager for {name}</Trans>}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={create.isPending}
                onClick={() => setAdding(false)}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                disabled={!userId.trim()}
                isLoading={create.isPending}
                onClick={() =>
                  create.mutate(
                    { manager_role: tenantManagerRoleForScope('project'), user_id: userId.trim() },
                    {
                      onSuccess: () => {
                        setUserId('')
                        setAdding(false)
                      },
                    },
                  )
                }
              >
                <Trans>Add manager</Trans>
              </Button>
            </>
          }
        >
          <Field
            label={<Trans>User ID</Trans>}
            hint={t`Find the ID on the user's page under Users.`}
          >
            <Input
              value={userId}
              onChange={(event) => setUserId(event.currentTarget.value)}
              spellCheck={false}
            />
          </Field>
          {create.error ? <Alert tone="error">{errorMessage(create.error)}</Alert> : null}
        </Dialog>
      ) : null}
    </section>
  )
}

export function ProjectSettingsTab({
  project,
  canManage,
}: {
  project: ProjectRecord
  canManage: boolean
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const location = useLocation()
  const navigate = useNavigate()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateProjectRecord(project.id)
  const { remove } = useProjectLifecycle(project.id)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [deleting, setDeleting] = useState(false)
  const current = project.name

  function submit(event: FormEvent): void {
    event.preventDefault()
    update.mutate(
      { name: name.trim(), description: description.trim() || null },
      { onSuccess: () => notify({ title: t`Project details saved` }) },
    )
  }

  return (
    <>
      <section {...stylex.props(detail.section)}>
        <h2 {...stylex.props(detail.sectionTitle)}>
          <Trans>Project details</Trans>
        </h2>
        <form onSubmit={submit} noValidate {...stylex.props(detail.section)}>
          <Field label={<Trans>Name</Trans>}>
            <Input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              maxLength={256}
              disabled={!canManage}
            />
          </Field>
          <Field
            label={<Trans>Description</Trans>}
            hint={<Trans>Shown to admins of organizations you share {current} with.</Trans>}
          >
            <Textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              disabled={!canManage}
            />
          </Field>
          <Field label={<Trans>Project ID</Trans>}>
            <CopyField value={project.id} subject={t`project ID`} />
          </Field>
          {update.error ? <Alert tone="error">{errorMessage(update.error)}</Alert> : null}
          {canManage ? (
            <div>
              <Button type="submit" disabled={!name.trim()} isLoading={update.isPending}>
                <Trans>Save project details</Trans>
              </Button>
            </div>
          ) : null}
        </form>
      </section>
      {canManage ? (
        <section {...stylex.props(detail.section)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Trans>Delete {current}</Trans>
          </h2>
          <div {...stylex.props(detail.itemRow)}>
            <div {...stylex.props(detail.itemMain)}>
              <span {...stylex.props(detail.itemSub)}>
                <Trans>
                  Deleting moves the project to the deleted list. You can restore {current} from
                  Projects with Show deleted turned on.
                </Trans>
              </span>
            </div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Trans>Delete project…</Trans>
            </Button>
          </div>
        </section>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={<Trans>Delete {current}?</Trans>}
          description={
            <Trans>
              Applications and roles in {current} stop authorizing access until you restore it.
            </Trans>
          }
          confirmLabel={<Trans>Delete project</Trans>}
          isLoading={remove.isPending}
          error={errorMessage(remove.error)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                notify({ title: t`${current} was deleted` })
                navigate(withOrgId(ORG_PROJECTS_PATH, location.search))
              },
            })
          }
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </>
  )
}
