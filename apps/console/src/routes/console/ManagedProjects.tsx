import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { useAuth } from '@xid-kit/web-ui/session'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { controlPlaneStyles as styles } from '../control-plane.styles'
import OrgRoles from '../org/OrgRoles'
import {
  useCreateUserGrant,
  useDeleteManagedProject,
  useManagedProjectGrantQuery,
  useManagedProjectQuery,
  useProjectRolesQuery,
  useRestoreManagedProject,
  useRevokeUserGrant,
  useUpdateManagedProject,
  useUserGrantsQuery,
} from '../org/queries'
import type { UserGrant } from '../org/types'

export default function ManagedProjects(): ReactNode {
  const { t } = useLingui()
  const { managerAssignments, refresh } = useAuth()
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('')
  const assignment =
    managerAssignments.find((candidate) => candidate.id === selectedAssignmentId) ??
    managerAssignments[0] ??
    null
  const isProjectManager = assignment?.managerRole === 'project_manager'
  const grantId = assignment?.scopeType === 'grant' ? assignment.scopeId : ''
  const grant = useManagedProjectGrantQuery(grantId)
  const projectId =
    assignment?.scopeType === 'project'
      ? assignment.scopeId
      : (grant.data?.granted_project_id ?? '')
  const projectResult = useManagedProjectQuery(
    projectId,
    grantId || undefined,
    isProjectManager ? 'all' : 'active',
  )
  const project = projectResult.data?.data[0] ?? null

  const updateProject = useUpdateManagedProject()
  const deleteProject = useDeleteManagedProject()
  const restoreProject = useRestoreManagedProject()
  const [editingProject, setEditingProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [pendingProjectDelete, setPendingProjectDelete] = useState(false)

  const [userGrantCursor, setUserGrantCursor] = useState<string | undefined>()
  const userGrants = useUserGrantsQuery(projectId, grantId, userGrantCursor)
  const grantRoles = useProjectRolesQuery(projectId, 'active', undefined, grantId || undefined)
  const createUserGrant = useCreateUserGrant(projectId, grantId)
  const revokeUserGrant = useRevokeUserGrant(projectId, grantId)
  const [grantUserId, setGrantUserId] = useState('')
  const [grantRoleId, setGrantRoleId] = useState('')
  const [pendingUserGrantRevoke, setPendingUserGrantRevoke] = useState<UserGrant | null>(null)

  const userGrantColumns: ColumnDef<UserGrant>[] = [
    {
      id: 'user',
      header: () => <Trans>User ID</Trans>,
      cell: ({ row }) => <code {...stylex.props(styles.mono)}>{row.original.user_id}</code>,
    },
    {
      id: 'role',
      header: () => <Trans>Role</Trans>,
      cell: ({ row }) => {
        const role = grantRoles.data?.data.find(
          (candidate) => candidate.id === row.original.role_id,
        )
        return (
          <div>
            <code {...stylex.props(styles.mono)}>{role?.key ?? row.original.role_id}</code>
            {role ? <div {...stylex.props(styles.muted)}>{role.display_name}</div> : null}
          </div>
        )
      },
    },
    {
      id: 'created',
      header: () => <Trans>Granted</Trans>,
      cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString(),
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Button
          variant="danger"
          onClick={() => setPendingUserGrantRevoke(row.original)}
          {...stylex.props(styles.actionButton)}
        >
          <Trans>Revoke</Trans>
        </Button>
      ),
      meta: { width: '110px' },
    },
  ]

  async function handleUpdateProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!project || !projectName.trim()) return
    await updateProject.mutateAsync({
      id: project.id,
      payload: {
        name: projectName.trim(),
        description: projectDescription.trim() || null,
      },
    })
    setEditingProject(false)
  }

  async function confirmDeleteProject(): Promise<void> {
    if (!project) return
    await deleteProject.mutateAsync(project.id)
    setPendingProjectDelete(false)
    await refresh()
  }

  async function handleRestoreProject(): Promise<void> {
    if (!project) return
    await restoreProject.mutateAsync(project.id)
    await refresh()
  }

  async function handleCreateUserGrant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!grantUserId.trim() || !grantRoleId) return
    await createUserGrant.mutateAsync({
      user_id: grantUserId.trim(),
      role_id: grantRoleId,
    })
    setGrantUserId('')
    setGrantRoleId('')
  }

  const projectMutationError = updateProject.error ?? deleteProject.error ?? restoreProject.error
  const userGrantMutationError = createUserGrant.error ?? revokeUserGrant.error

  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Managed projects</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Work only inside the project or project grant scopes delegated to your user. These
            assignments do not grant organization administrator access.
          </Trans>
        </p>
      </header>

      {managerAssignments.length === 0 ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="info">
            <Trans>No project management scopes are assigned to your user.</Trans>
          </Alert>
        </div>
      ) : (
        <>
          <div {...stylex.props(styles.toolbar)}>
            <div {...stylex.props(styles.toolbarField)}>
              <Field
                label={<Trans>Managed scope</Trans>}
                hint={
                  <Trans>
                    Project managers can change definitions. Project grant managers can read
                    definitions and manage user grants for one exact grant.
                  </Trans>
                }
              >
                <select
                  value={assignment?.id ?? ''}
                  onChange={(event) => {
                    setSelectedAssignmentId(event.currentTarget.value)
                    setUserGrantCursor(undefined)
                    setEditingProject(false)
                  }}
                  {...stylex.props(styles.select)}
                >
                  {managerAssignments.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.managerRole === 'project_manager'
                        ? t`Project manager`
                        : t`Project grant manager`}{' '}
                      · {candidate.scopeId}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {assignment ? (
              <Badge tone={assignment.scopeStatus === 'active' ? 'success' : 'neutral'}>
                {assignment.scopeStatus === 'active' ? (
                  <Trans>Active</Trans>
                ) : (
                  <Trans>Deleted</Trans>
                )}
              </Badge>
            ) : null}
          </div>

          {grant.isError || projectResult.isError ? (
            <div {...stylex.props(styles.message)}>
              <Alert tone="error">
                <Trans>Failed to resolve the selected managed scope.</Trans>
              </Alert>
            </div>
          ) : !project ? (
            <div {...stylex.props(styles.message)}>
              <Alert tone="info">
                <Trans>Resolving the selected project.</Trans>
              </Alert>
            </div>
          ) : (
            <>
              <section aria-labelledby="managed-project-heading" {...stylex.props(styles.section)}>
                <div {...stylex.props(styles.sectionStack)}>
                  <div {...stylex.props(styles.sectionHeadingRow)}>
                    <div>
                      <h2 id="managed-project-heading" {...stylex.props(page.sectionLabel)}>
                        {project.name}
                      </h2>
                      <code {...stylex.props(styles.mono)}>{project.id}</code>
                    </div>
                    <Badge tone={project.status === 'active' ? 'success' : 'neutral'}>
                      {project.status === 'active' ? <Trans>Active</Trans> : <Trans>Deleted</Trans>}
                    </Badge>
                  </div>
                  {project.description ? (
                    <p {...stylex.props(styles.sectionDescription)}>{project.description}</p>
                  ) : null}
                  {grant.data ? (
                    <p {...stylex.props(styles.selectorSummary)}>
                      <Trans>
                        Grant {grant.data.id} targets organization {grant.data.granted_to_org_id}
                      </Trans>
                    </p>
                  ) : null}
                  {projectMutationError ? (
                    <Alert tone="error">{projectMutationError.message}</Alert>
                  ) : null}
                  {isProjectManager ? (
                    project.status === 'deleted' ? (
                      <div {...stylex.props(styles.formActions)}>
                        <Button
                          isLoading={restoreProject.isPending}
                          onClick={() => void handleRestoreProject()}
                        >
                          <Trans>Restore project</Trans>
                        </Button>
                        <p {...stylex.props(styles.sectionDescription)}>
                          <Trans>
                            Restore this project before changing roles, permissions, or mappings.
                          </Trans>
                        </p>
                      </div>
                    ) : (
                      <div {...stylex.props(styles.formActions)}>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setProjectName(project.name)
                            setProjectDescription(project.description ?? '')
                            setEditingProject(true)
                          }}
                        >
                          <Trans>Edit project</Trans>
                        </Button>
                        <Button variant="danger" onClick={() => setPendingProjectDelete(true)}>
                          <Trans>Delete project</Trans>
                        </Button>
                      </div>
                    )
                  ) : (
                    <Alert tone="info">
                      <Trans>
                        This grant manager scope is read-only for project definitions. User grants
                        for the exact project grant remain writable below.
                      </Trans>
                    </Alert>
                  )}
                </div>
              </section>

              {editingProject && project.status === 'active' ? (
                <section
                  aria-labelledby="managed-project-edit-heading"
                  {...stylex.props(styles.createSection)}
                >
                  <div {...stylex.props(styles.sectionMeta)}>
                    <h2 id="managed-project-edit-heading" {...stylex.props(page.sectionLabel)}>
                      <Trans>Edit project</Trans>
                    </h2>
                    <p {...stylex.props(styles.sectionDescription)}>
                      <Trans>
                        Project identity remains stable while its name and description change.
                      </Trans>
                    </p>
                  </div>
                  <form
                    onSubmit={(event) => void handleUpdateProject(event)}
                    {...stylex.props(styles.controls)}
                  >
                    <div {...stylex.props(styles.formGrid)}>
                      <Field label={<Trans>Project name</Trans>} required>
                        <Input
                          value={projectName}
                          onChange={(event) => setProjectName(event.currentTarget.value)}
                          maxLength={256}
                        />
                      </Field>
                      <Field label={<Trans>Description</Trans>}>
                        <Input
                          value={projectDescription}
                          onChange={(event) => setProjectDescription(event.currentTarget.value)}
                          maxLength={2000}
                        />
                      </Field>
                    </div>
                    <div {...stylex.props(styles.formActions)}>
                      <Button
                        type="submit"
                        isLoading={updateProject.isPending}
                        disabled={!projectName.trim()}
                      >
                        <Trans>Save project</Trans>
                      </Button>
                      <Button variant="secondary" onClick={() => setEditingProject(false)}>
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </form>
                </section>
              ) : null}

              {project.status === 'active' ? (
                <OrgRoles
                  managedProjectId={project.id}
                  grantId={grantId || undefined}
                  readOnly={!isProjectManager}
                  embedded
                />
              ) : null}

              {assignment?.managerRole === 'project_grant_manager' &&
              project.status === 'active' ? (
                <section
                  aria-labelledby="user-grants-heading"
                  {...stylex.props(styles.createSection)}
                >
                  <div {...stylex.props(styles.sectionMeta)}>
                    <h2 id="user-grants-heading" {...stylex.props(page.sectionLabel)}>
                      <Trans>User grants</Trans>
                    </h2>
                    <p {...stylex.props(styles.sectionDescription)}>
                      <Trans>
                        Assign one active role to a user who is an active member of the grant target
                        organization. Enter an exact user ID; the server verifies membership and the
                        exact grant.
                      </Trans>
                    </p>
                  </div>
                  <div {...stylex.props(styles.controls)}>
                    {userGrantMutationError ? (
                      <Alert tone="error">{userGrantMutationError.message}</Alert>
                    ) : null}
                    {userGrants.isError ? (
                      <Alert tone="error">
                        <Trans>Failed to load user grants.</Trans>
                      </Alert>
                    ) : (
                      <>
                        <DataTable
                          columns={userGrantColumns}
                          data={userGrants.data?.data ?? []}
                          getRowId={(userGrant) => userGrant.id}
                          isLoading={userGrants.isLoading}
                          emptyMessage={<Trans>No active user grants.</Trans>}
                        />
                        {userGrants.data ? (
                          <Pagination
                            nextCursor={userGrants.data.next_cursor}
                            loadMoreLabel={<Trans>Load more user grants</Trans>}
                            onLoadMore={setUserGrantCursor}
                          />
                        ) : null}
                      </>
                    )}
                    <form
                      onSubmit={(event) => void handleCreateUserGrant(event)}
                      {...stylex.props(styles.sectionStack)}
                    >
                      <div {...stylex.props(styles.formGrid)}>
                        <Field label={<Trans>User ID</Trans>} required>
                          <Input
                            value={grantUserId}
                            onChange={(event) => setGrantUserId(event.currentTarget.value)}
                            placeholder={t`user_...`}
                          />
                        </Field>
                        <Field label={<Trans>Role</Trans>} required>
                          <select
                            value={grantRoleId}
                            onChange={(event) => setGrantRoleId(event.currentTarget.value)}
                            disabled={(grantRoles.data?.data.length ?? 0) === 0}
                            {...stylex.props(styles.select)}
                          >
                            <option value="">{t`Select role`}</option>
                            {(grantRoles.data?.data ?? []).map((role) => (
                              <option key={role.id} value={role.id}>
                                {role.display_name} ({role.key})
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div {...stylex.props(styles.formActions)}>
                        <Button
                          type="submit"
                          isLoading={createUserGrant.isPending}
                          disabled={!grantUserId.trim() || !grantRoleId}
                        >
                          <Trans>Grant role to user</Trans>
                        </Button>
                      </div>
                    </form>
                  </div>
                </section>
              ) : null}
            </>
          )}
        </>
      )}

      {pendingProjectDelete && project ? (
        <ConfirmDialog
          title={<Trans>Delete managed project?</Trans>}
          description={
            <Trans>
              {project.name} will stop authorizing access. Your assignment remains discoverable so
              you can restore the project.
            </Trans>
          }
          confirmLabel={<Trans>Delete project</Trans>}
          isLoading={deleteProject.isPending}
          onConfirm={() => void confirmDeleteProject()}
          onCancel={() => setPendingProjectDelete(false)}
        />
      ) : null}

      {pendingUserGrantRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke user grant?</Trans>}
          description={
            <Trans>
              User {pendingUserGrantRevoke.user_id} will lose the selected role for this exact
              project grant.
            </Trans>
          }
          confirmLabel={<Trans>Revoke user grant</Trans>}
          isLoading={revokeUserGrant.isPending}
          onConfirm={() => {
            void revokeUserGrant
              .mutateAsync(pendingUserGrantRevoke.id)
              .then(() => setPendingUserGrantRevoke(null))
          }}
          onCancel={() => setPendingUserGrantRevoke(null)}
        />
      ) : null}
    </div>
  )
}
