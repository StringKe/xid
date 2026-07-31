import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { tenantManagerRoleForScope } from '@xid-kit/types'
import { Alert, Button, Field, Input } from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { useAuth } from '@xid-kit/web-ui/session'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { controlPlaneStyles as styles } from '../control-plane.styles'
import {
  useCreateManagerAssignment,
  useCreateProject,
  useCreateProjectGrant,
  useDeleteManagerAssignment,
  useDeleteProject,
  useManagerAssignmentsQuery,
  useOrgMembersQuery,
  useProjectGrantsQuery,
  useProjectsQuery,
  useRestoreProject,
  useRevokeProjectGrant,
  useUpdateProject,
} from './queries'
import type { ManagerAssignment, ManagerScopeType, Project, ProjectGrant } from './types'
import { useOrgTarget } from './useOrgTarget'

function managerRoleLabel(scopeType: ManagerScopeType): ReactNode {
  if (scopeType === 'org') return <Trans>Organization manager</Trans>
  if (scopeType === 'project') return <Trans>Project manager</Trans>
  return <Trans>Project grant manager</Trans>
}

export default function OrgProjects(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { organizations, user } = useAuth()

  const [activeCursor, setActiveCursor] = useState<string | undefined>()
  const [deletedCursor, setDeletedCursor] = useState<string | undefined>()
  const [grantCursor, setGrantCursor] = useState<string | undefined>()
  const [assignmentCursor, setAssignmentCursor] = useState<string | undefined>()
  const activeProjects = useProjectsQuery(orgId, 'active', activeCursor)
  const deletedProjects = useProjectsQuery(orgId, 'deleted', deletedCursor)

  const [selectedProjectId, setSelectedProjectId] = useState('')
  const selectedProject =
    activeProjects.data?.data.find((project) => project.id === selectedProjectId) ??
    activeProjects.data?.data[0] ??
    null
  const projectId = selectedProject?.id ?? ''

  const projectGrants = useProjectGrantsQuery(projectId, grantCursor)
  const grants = projectGrants.data?.data ?? []
  const [selectedGrantId, setSelectedGrantId] = useState('')
  const grantId = grants.find((grant) => grant.id === selectedGrantId)?.id ?? grants[0]?.id ?? ''
  const members = useOrgMembersQuery(orgId)

  const [scopeType, setScopeType] = useState<ManagerScopeType>('org')
  const scopeId = scopeType === 'org' ? orgId : scopeType === 'project' ? projectId : grantId
  const assignments = useManagerAssignmentsQuery(scopeType, scopeId, assignmentCursor)
  const createAssignment = useCreateManagerAssignment(scopeType, scopeId)
  const deleteAssignment = useDeleteManagerAssignment(scopeType, scopeId)

  const createProject = useCreateProject(orgId)
  const updateProject = useUpdateProject(orgId)
  const deleteProject = useDeleteProject(orgId)
  const restoreProject = useRestoreProject(orgId)
  const createGrant = useCreateProjectGrant(projectId, orgId)
  const revokeGrant = useRevokeProjectGrant(projectId)

  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)
  const [pendingGrantRevoke, setPendingGrantRevoke] = useState<ProjectGrant | null>(null)
  const [pendingAssignmentRevoke, setPendingAssignmentRevoke] = useState<ManagerAssignment | null>(
    null,
  )
  const [targetOrgId, setTargetOrgId] = useState('')
  const [managerUserId, setManagerUserId] = useState('')
  const isCurrentOrganizationTarget = targetOrgId.trim() === orgId

  const activeColumns: ColumnDef<Project>[] = [
    {
      id: 'name',
      header: () => <Trans>Project</Trans>,
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <code {...stylex.props(styles.mono)}>{row.original.id}</code>
        </div>
      ),
    },
    {
      id: 'description',
      header: () => <Trans>Description</Trans>,
      cell: ({ row }) => row.original.description || <Trans>No description</Trans>,
    },
    {
      id: 'updated',
      header: () => <Trans>Updated</Trans>,
      cell: ({ row }) => new Date(row.original.updated_at).toLocaleDateString(),
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(styles.actionGroup)}>
          <Button
            variant={row.original.id === projectId ? 'primary' : 'secondary'}
            onClick={() => {
              setSelectedProjectId(row.original.id)
              setSelectedGrantId('')
              setGrantCursor(undefined)
              if (scopeType !== 'org') setAssignmentCursor(undefined)
            }}
            {...stylex.props(styles.actionButton)}
          >
            {row.original.id === projectId ? <Trans>Selected</Trans> : <Trans>Select</Trans>}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditingProject(row.original)
              setEditName(row.original.name)
              setEditDescription(row.original.description ?? '')
            }}
            {...stylex.props(styles.actionButton)}
          >
            <Trans>Edit</Trans>
          </Button>
          <Button
            variant="danger"
            onClick={() => setPendingDelete(row.original)}
            {...stylex.props(styles.actionButton)}
          >
            <Trans>Delete</Trans>
          </Button>
        </div>
      ),
      meta: { width: '250px' },
    },
  ]

  const deletedColumns: ColumnDef<Project>[] = [
    {
      id: 'name',
      header: () => <Trans>Project</Trans>,
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <code {...stylex.props(styles.mono)}>{row.original.id}</code>
        </div>
      ),
    },
    {
      id: 'deleted',
      header: () => <Trans>Deleted</Trans>,
      cell: ({ row }) =>
        row.original.deleted_at ? new Date(row.original.deleted_at).toLocaleDateString() : '-',
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Button
          variant="secondary"
          isLoading={restoreProject.isPending && restoreProject.variables === row.original.id}
          onClick={() => void restoreProject.mutateAsync(row.original.id)}
          {...stylex.props(styles.actionButton)}
        >
          <Trans>Restore</Trans>
        </Button>
      ),
      meta: { width: '120px' },
    },
  ]

  const grantColumns: ColumnDef<ProjectGrant>[] = [
    {
      id: 'target',
      header: () => <Trans>Target organization ID</Trans>,
      cell: ({ row }) => (
        <code {...stylex.props(styles.mono)}>{row.original.granted_to_org_id}</code>
      ),
    },
    {
      id: 'id',
      header: () => <Trans>Grant ID</Trans>,
      cell: ({ row }) => <code {...stylex.props(styles.mono)}>{row.original.id}</code>,
    },
    {
      id: 'created',
      header: () => <Trans>Created</Trans>,
      cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString(),
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(styles.actionGroup)}>
          <Button
            variant={row.original.id === grantId ? 'primary' : 'secondary'}
            onClick={() => {
              setSelectedGrantId(row.original.id)
              if (scopeType === 'grant') setAssignmentCursor(undefined)
            }}
            {...stylex.props(styles.actionButton)}
          >
            {row.original.id === grantId ? <Trans>Selected</Trans> : <Trans>Select</Trans>}
          </Button>
          <Button
            variant="danger"
            onClick={() => setPendingGrantRevoke(row.original)}
            {...stylex.props(styles.actionButton)}
          >
            <Trans>Revoke</Trans>
          </Button>
        </div>
      ),
      meta: { width: '170px' },
    },
  ]

  const assignmentColumns: ColumnDef<ManagerAssignment>[] = [
    {
      id: 'user',
      header: () => <Trans>User ID</Trans>,
      cell: ({ row }) => <code {...stylex.props(styles.mono)}>{row.original.user_id}</code>,
    },
    {
      id: 'role',
      header: () => <Trans>Manager role</Trans>,
      cell: ({ row }) => managerRoleLabel(row.original.scope_type),
      meta: { width: '210px' },
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
          disabled={row.original.user_id === user?.id}
          onClick={() => setPendingAssignmentRevoke(row.original)}
          aria-label={t`Revoke manager assignment for ${row.original.user_id}`}
          {...stylex.props(styles.actionButton)}
        >
          <Trans>Revoke</Trans>
        </Button>
      ),
      meta: { width: '110px' },
    },
  ]

  async function handleCreateProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!projectName.trim()) return
    const result = await createProject.mutateAsync({
      name: projectName.trim(),
      description: projectDescription.trim() || undefined,
    })
    setProjectName('')
    setProjectDescription('')
    setSelectedProjectId(result.id)
  }

  async function handleUpdateProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!editingProject || !editName.trim()) return
    await updateProject.mutateAsync({
      id: editingProject.id,
      payload: {
        name: editName.trim(),
        description: editDescription.trim() || null,
      },
    })
    setEditingProject(null)
  }

  async function handleCreateGrant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!targetOrgId.trim() || !projectId || isCurrentOrganizationTarget) return
    const result = await createGrant.mutateAsync({ granted_to_org_id: targetOrgId.trim() })
    setTargetOrgId('')
    setSelectedGrantId(result.id)
  }

  async function handleCreateAssignment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!managerUserId.trim() || !scopeId || managerUserId.trim() === user?.id) return
    await createAssignment.mutateAsync({
      user_id: managerUserId.trim(),
      manager_role: tenantManagerRoleForScope(scopeType),
    })
    setManagerUserId('')
  }

  if (!orgId) {
    return (
      <div {...stylex.props(styles.message)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  const mutationError =
    createProject.error ??
    updateProject.error ??
    deleteProject.error ??
    restoreProject.error ??
    createGrant.error ??
    revokeGrant.error ??
    createAssignment.error ??
    deleteAssignment.error

  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Projects and access</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Projects isolate business roles and permissions. Select one project to manage its
            cross-organization grants and delegated managers.
          </Trans>
        </p>
      </header>

      {mutationError ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="error">{mutationError.message}</Alert>
        </div>
      ) : null}

      <section aria-labelledby="active-projects-heading" {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionStack)}>
          <div {...stylex.props(styles.sectionHeadingRow)}>
            <h2 id="active-projects-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Active projects</Trans>
            </h2>
            {selectedProject ? (
              <p {...stylex.props(styles.selectorSummary)}>
                <Trans>Selected project: {selectedProject.name}</Trans>
              </p>
            ) : null}
          </div>
          {activeProjects.isError ? (
            <Alert tone="error">
              <Trans>Failed to load projects.</Trans>
            </Alert>
          ) : (
            <>
              <DataTable
                columns={activeColumns}
                data={activeProjects.data?.data ?? []}
                getRowId={(project) => project.id}
                isLoading={activeProjects.isLoading}
                emptyMessage={<Trans>No active projects.</Trans>}
              />
              {activeProjects.data ? (
                <Pagination
                  nextCursor={activeProjects.data.next_cursor}
                  loadMoreLabel={<Trans>Load more projects</Trans>}
                  onLoadMore={setActiveCursor}
                />
              ) : null}
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="create-project-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="create-project-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Create project</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDescription)}>
            <Trans>
              A project is the namespace for role keys, permission keys, and user grants.
            </Trans>
          </p>
        </div>
        <form
          onSubmit={(event) => void handleCreateProject(event)}
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
              isLoading={createProject.isPending}
              disabled={!projectName.trim()}
            >
              <Trans>Create project</Trans>
            </Button>
          </div>
        </form>
      </section>

      {editingProject ? (
        <section aria-labelledby="edit-project-heading" {...stylex.props(styles.createSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="edit-project-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Edit project</Trans>
            </h2>
            <code {...stylex.props(styles.mono)}>{editingProject.id}</code>
          </div>
          <form
            onSubmit={(event) => void handleUpdateProject(event)}
            {...stylex.props(styles.controls)}
          >
            <div {...stylex.props(styles.formGrid)}>
              <Field label={<Trans>Project name</Trans>} required>
                <Input
                  value={editName}
                  onChange={(event) => setEditName(event.currentTarget.value)}
                  maxLength={256}
                />
              </Field>
              <Field label={<Trans>Description</Trans>}>
                <Input
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.currentTarget.value)}
                  maxLength={2000}
                />
              </Field>
            </div>
            <div {...stylex.props(styles.formActions)}>
              <Button type="submit" isLoading={updateProject.isPending} disabled={!editName.trim()}>
                <Trans>Save project</Trans>
              </Button>
              <Button variant="secondary" onClick={() => setEditingProject(null)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="project-grants-heading" {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionStack)}>
          <div>
            <h2 id="project-grants-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Cross-organization grants</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDescription)}>
              <Trans>
                Grant the selected project to another organization in this tenant. Revoking a
                project grant also revokes user grants issued through it.
              </Trans>
            </p>
          </div>
          {!projectId ? (
            <Alert tone="info">
              <Trans>Create or select an active project first.</Trans>
            </Alert>
          ) : projectGrants.isError ? (
            <Alert tone="error">
              <Trans>Failed to load project grants.</Trans>
            </Alert>
          ) : (
            <>
              <DataTable
                columns={grantColumns}
                data={grants}
                getRowId={(grant) => grant.id}
                isLoading={projectGrants.isLoading}
                emptyMessage={<Trans>No active grants for this project.</Trans>}
              />
              {projectGrants.data ? (
                <Pagination
                  nextCursor={projectGrants.data.next_cursor}
                  loadMoreLabel={<Trans>Load more project grants</Trans>}
                  onLoadMore={setGrantCursor}
                />
              ) : null}
              <form
                onSubmit={(event) => void handleCreateGrant(event)}
                {...stylex.props(styles.formActions)}
              >
                <div {...stylex.props(styles.toolbarField)}>
                  <Field
                    label={<Trans>Target organization ID</Trans>}
                    required
                    error={
                      isCurrentOrganizationTarget
                        ? t`A project grant must target another organization.`
                        : undefined
                    }
                    hint={
                      <Trans>Choose a known organization or enter an exact organization ID.</Trans>
                    }
                  >
                    <Input
                      list="project-grant-organizations"
                      value={targetOrgId}
                      onChange={(event) => setTargetOrgId(event.currentTarget.value)}
                      placeholder={t`org_...`}
                    />
                  </Field>
                  <datalist id="project-grant-organizations">
                    {organizations
                      .filter((organization) => organization.id !== orgId)
                      .map((organization) => (
                        <option key={organization.id} value={organization.id}>
                          {organization.name || organization.slug}
                        </option>
                      ))}
                  </datalist>
                </div>
                <Button
                  type="submit"
                  isLoading={createGrant.isPending}
                  disabled={!targetOrgId.trim() || isCurrentOrganizationTarget}
                >
                  <Trans>Create grant</Trans>
                </Button>
              </form>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="manager-access-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="manager-access-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Delegated managers</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDescription)}>
            <Trans>
              Assign one exact management role to the matching organization, project, or grant
              scope. A manager cannot delegate or revoke their own assignment.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controls)}>
          <div {...stylex.props(styles.formGrid)}>
            <Field label={<Trans>Scope type</Trans>}>
              <select
                value={scopeType}
                onChange={(event) => {
                  setScopeType(event.currentTarget.value as ManagerScopeType)
                  setAssignmentCursor(undefined)
                }}
                {...stylex.props(styles.select)}
              >
                <option value="org">{t`Organization`}</option>
                <option value="project">{t`Selected project`}</option>
                <option value="grant">{t`Selected project grant`}</option>
              </select>
            </Field>
            <Field label={<Trans>Scope ID</Trans>}>
              <Input value={scopeId} readOnly />
            </Field>
          </div>
          <p {...stylex.props(styles.selectorSummary)}>
            <Trans>Role: {managerRoleLabel(scopeType)}</Trans>
          </p>
          {!scopeId ? (
            <Alert tone="info">
              {scopeType === 'grant' ? (
                <Trans>Select a project with an active grant first.</Trans>
              ) : (
                <Trans>Select an active project first.</Trans>
              )}
            </Alert>
          ) : assignments.isError ? (
            <Alert tone="error">
              <Trans>Failed to load manager assignments.</Trans>
            </Alert>
          ) : (
            <>
              <DataTable
                columns={assignmentColumns}
                data={assignments.data?.data ?? []}
                getRowId={(assignment) => assignment.id}
                isLoading={assignments.isLoading}
                emptyMessage={<Trans>No managers assigned to this scope.</Trans>}
              />
              {assignments.data ? (
                <Pagination
                  nextCursor={assignments.data.next_cursor}
                  loadMoreLabel={<Trans>Load more manager assignments</Trans>}
                  onLoadMore={setAssignmentCursor}
                />
              ) : null}
              <form
                onSubmit={(event) => void handleCreateAssignment(event)}
                {...stylex.props(styles.formActions)}
              >
                <div {...stylex.props(styles.toolbarField)}>
                  <Field
                    label={<Trans>Manager user ID</Trans>}
                    error={
                      managerUserId.trim() === user?.id
                        ? t`You cannot grant a manager assignment to yourself.`
                        : undefined
                    }
                    hint={
                      <Trans>
                        Choose a current member or enter an exact active user ID. The server
                        verifies the user and scope.
                      </Trans>
                    }
                  >
                    <Input
                      list="manager-member-ids"
                      value={managerUserId}
                      onChange={(event) => setManagerUserId(event.currentTarget.value)}
                      placeholder={t`user_...`}
                    />
                  </Field>
                  <datalist id="manager-member-ids">
                    {(members.data?.data ?? []).map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.email}
                      </option>
                    ))}
                  </datalist>
                </div>
                <Button
                  type="submit"
                  isLoading={createAssignment.isPending}
                  disabled={!scopeId || !managerUserId.trim() || managerUserId.trim() === user?.id}
                >
                  <Trans>Grant manager role</Trans>
                </Button>
              </form>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="recycle-bin-heading" {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionStack)}>
          <div>
            <h2 id="recycle-bin-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Project recycle bin</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDescription)}>
              <Trans>
                Deleted projects remain recoverable. Their roles, permissions, and grants are
                unavailable until the project is restored.
              </Trans>
            </p>
          </div>
          {deletedProjects.isError ? (
            <Alert tone="error">
              <Trans>Failed to load deleted projects.</Trans>
            </Alert>
          ) : (
            <>
              <DataTable
                columns={deletedColumns}
                data={deletedProjects.data?.data ?? []}
                getRowId={(project) => project.id}
                isLoading={deletedProjects.isLoading}
                emptyMessage={<Trans>No deleted projects.</Trans>}
              />
              {deletedProjects.data ? (
                <Pagination
                  nextCursor={deletedProjects.data.next_cursor}
                  loadMoreLabel={<Trans>Load more deleted projects</Trans>}
                  onLoadMore={setDeletedCursor}
                />
              ) : null}
            </>
          )}
        </div>
      </section>

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete project?</Trans>}
          description={
            <Trans>
              {pendingDelete.name} will move to the recycle bin and stop authorizing access until
              restored.
            </Trans>
          }
          confirmLabel={<Trans>Delete project</Trans>}
          isLoading={deleteProject.isPending}
          onConfirm={() => {
            void deleteProject.mutateAsync(pendingDelete.id).then(() => setPendingDelete(null))
          }}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}

      {pendingGrantRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke project grant?</Trans>}
          description={
            <Trans>
              Access for organization {pendingGrantRevoke.granted_to_org_id} and user grants issued
              through this grant will be revoked.
            </Trans>
          }
          confirmLabel={<Trans>Revoke grant</Trans>}
          isLoading={revokeGrant.isPending}
          onConfirm={() => {
            void revokeGrant
              .mutateAsync(pendingGrantRevoke.id)
              .then(() => setPendingGrantRevoke(null))
          }}
          onCancel={() => setPendingGrantRevoke(null)}
        />
      ) : null}

      {pendingAssignmentRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke manager assignment?</Trans>}
          description={
            <Trans>
              User {pendingAssignmentRevoke.user_id} will lose management access to this exact
              scope.
            </Trans>
          }
          confirmLabel={<Trans>Revoke assignment</Trans>}
          isLoading={deleteAssignment.isPending}
          onConfirm={() => {
            void deleteAssignment
              .mutateAsync(pendingAssignmentRevoke.id)
              .then(() => setPendingAssignmentRevoke(null))
          }}
          onCancel={() => setPendingAssignmentRevoke(null)}
        />
      ) : null}
    </div>
  )
}
