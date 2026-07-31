import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Button, Field, Input } from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  formatConditionExpression,
  parseConditionExpression,
  type ParsedConditionExpression,
} from './condition-expression'
import { controlPlaneStyles as styles } from '../control-plane.styles'
import {
  useCreateProjectPermission,
  useCreateProjectRole,
  useCreateRolePermission,
  useDeleteProjectPermission,
  useDeleteProjectRole,
  useDeleteRolePermission,
  useProjectPermissionsQuery,
  useProjectRolesQuery,
  useProjectsQuery,
  useRestoreProjectPermission,
  useRestoreProjectRole,
  useRolePermissionsQuery,
  useUpdateProjectPermission,
  useUpdateProjectRole,
  useUpdateRolePermission,
} from './queries'
import type { ProjectPermission, ProjectRole, RolePermission } from './types'
import { useOrgTarget } from './useOrgTarget'

type PendingDelete =
  | { kind: 'role'; value: ProjectRole }
  | { kind: 'permission'; value: ProjectPermission }
  | { kind: 'mapping'; value: RolePermission }

function conditionErrorMessage(error: ParsedConditionExpression | null): ReactNode | undefined {
  if (!error || error.ok) return undefined
  if (error.reason === 'invalid_json') return <Trans>Enter valid JSON.</Trans>
  return <Trans>The condition must be a JSON object.</Trans>
}

export type OrgRolesProps = {
  managedProjectId?: string
  grantId?: string
  readOnly?: boolean
  embedded?: boolean
}

export default function OrgRoles({
  managedProjectId,
  grantId,
  readOnly = false,
  embedded = false,
}: OrgRolesProps = {}): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const managed = Boolean(managedProjectId)
  const canWrite = !readOnly
  const [projectCursor, setProjectCursor] = useState<string | undefined>()
  const projects = useProjectsQuery(orgId, 'active', projectCursor)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const selectedProject =
    projects.data?.data.find((project) => project.id === selectedProjectId) ??
    projects.data?.data[0] ??
    null
  const projectId = managedProjectId ?? selectedProject?.id ?? ''

  const [roleCursor, setRoleCursor] = useState<string | undefined>()
  const [deletedRoleCursor, setDeletedRoleCursor] = useState<string | undefined>()
  const [permissionCursor, setPermissionCursor] = useState<string | undefined>()
  const [deletedPermissionCursor, setDeletedPermissionCursor] = useState<string | undefined>()
  const [mappingCursor, setMappingCursor] = useState<string | undefined>()
  const roles = useProjectRolesQuery(projectId, 'active', roleCursor, grantId)
  const deletedRoles = useProjectRolesQuery(canWrite ? projectId : '', 'deleted', deletedRoleCursor)
  const permissions = useProjectPermissionsQuery(projectId, 'active', permissionCursor, grantId)
  const deletedPermissions = useProjectPermissionsQuery(
    canWrite ? projectId : '',
    'deleted',
    deletedPermissionCursor,
  )

  const [selectedRoleId, setSelectedRoleId] = useState('')
  const selectedRole =
    roles.data?.data.find((role) => role.id === selectedRoleId) ?? roles.data?.data[0] ?? null
  const roleId = selectedRole?.id ?? ''
  const mappings = useRolePermissionsQuery(roleId, mappingCursor, grantId)

  const createRole = useCreateProjectRole(projectId)
  const updateRole = useUpdateProjectRole(projectId)
  const deleteRole = useDeleteProjectRole(projectId)
  const restoreRole = useRestoreProjectRole(projectId)
  const createPermission = useCreateProjectPermission(projectId)
  const updatePermission = useUpdateProjectPermission(projectId)
  const deletePermission = useDeleteProjectPermission(projectId)
  const restorePermission = useRestoreProjectPermission(projectId)
  const createMapping = useCreateRolePermission(roleId)
  const updateMapping = useUpdateRolePermission(roleId)
  const deleteMapping = useDeleteRolePermission(roleId)

  const [roleKey, setRoleKey] = useState('')
  const [roleName, setRoleName] = useState('')
  const [roleGroup, setRoleGroup] = useState('')
  const [permissionKey, setPermissionKey] = useState('')
  const [permissionDescription, setPermissionDescription] = useState('')
  const [editingRole, setEditingRole] = useState<ProjectRole | null>(null)
  const [editRoleName, setEditRoleName] = useState('')
  const [editRoleGroup, setEditRoleGroup] = useState('')
  const [editingPermission, setEditingPermission] = useState<ProjectPermission | null>(null)
  const [editPermissionDescription, setEditPermissionDescription] = useState('')
  const [mappingPermissionId, setMappingPermissionId] = useState('')
  const [conditionText, setConditionText] = useState('')
  const [conditionParse, setConditionParse] = useState<ParsedConditionExpression | null>(null)
  const [editingMapping, setEditingMapping] = useState<RolePermission | null>(null)
  const [editConditionText, setEditConditionText] = useState('')
  const [editConditionParse, setEditConditionParse] = useState<ParsedConditionExpression | null>(
    null,
  )
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)

  const roleColumns: ColumnDef<ProjectRole>[] = [
    {
      id: 'name',
      header: () => <Trans>Role</Trans>,
      cell: ({ row }) => (
        <div>
          <div>{row.original.display_name}</div>
          <code {...stylex.props(styles.mono)}>{row.original.key}</code>
        </div>
      ),
    },
    {
      id: 'group',
      header: () => <Trans>Group</Trans>,
      cell: ({ row }) => row.original.group || <Trans>No group</Trans>,
      meta: { width: '140px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(styles.actionGroup)}>
          <Button
            variant={row.original.id === roleId ? 'primary' : 'secondary'}
            onClick={() => {
              setSelectedRoleId(row.original.id)
              setMappingCursor(undefined)
            }}
            {...stylex.props(styles.actionButton)}
          >
            {row.original.id === roleId ? <Trans>Selected</Trans> : <Trans>Select</Trans>}
          </Button>
          {canWrite ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingRole(row.original)
                  setEditRoleName(row.original.display_name)
                  setEditRoleGroup(row.original.group ?? '')
                }}
                {...stylex.props(styles.actionButton)}
              >
                <Trans>Edit</Trans>
              </Button>
              <Button
                variant="danger"
                onClick={() => setPendingDelete({ kind: 'role', value: row.original })}
                {...stylex.props(styles.actionButton)}
              >
                <Trans>Delete</Trans>
              </Button>
            </>
          ) : null}
        </div>
      ),
      meta: { width: '250px' },
    },
  ]

  const permissionColumns: ColumnDef<ProjectPermission>[] = [
    {
      id: 'key',
      header: () => <Trans>Permission key</Trans>,
      cell: ({ row }) => <code {...stylex.props(styles.mono)}>{row.original.key}</code>,
    },
    {
      id: 'description',
      header: () => <Trans>Description</Trans>,
      cell: ({ row }) => row.original.description || <Trans>No description</Trans>,
    },
    ...(canWrite
      ? [
          {
            id: 'actions',
            header: () => <Trans>Actions</Trans>,
            cell: ({ row }: { row: { original: ProjectPermission } }) => (
              <div {...stylex.props(styles.actionGroup)}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingPermission(row.original)
                    setEditPermissionDescription(row.original.description ?? '')
                  }}
                  {...stylex.props(styles.actionButton)}
                >
                  <Trans>Edit</Trans>
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setPendingDelete({ kind: 'permission', value: row.original })}
                  {...stylex.props(styles.actionButton)}
                >
                  <Trans>Delete</Trans>
                </Button>
              </div>
            ),
            meta: { width: '160px' },
          } satisfies ColumnDef<ProjectPermission>,
        ]
      : []),
  ]

  const mappingColumns: ColumnDef<RolePermission>[] = [
    {
      id: 'permission',
      header: () => <Trans>Permission</Trans>,
      cell: ({ row }) => {
        const permission = permissions.data?.data.find(
          (candidate) => candidate.id === row.original.permission_id,
        )
        return (
          <div>
            <code {...stylex.props(styles.mono)}>
              {permission?.key ?? row.original.permission_id}
            </code>
            {permission ? (
              <div {...stylex.props(styles.muted)}>{permission.description}</div>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'condition',
      header: () => <Trans>ABAC condition</Trans>,
      cell: ({ row }) =>
        row.original.condition_expression ? (
          <code {...stylex.props(styles.codeBlock)}>
            {formatConditionExpression(row.original.condition_expression)}
          </code>
        ) : (
          <Trans>Unconditional</Trans>
        ),
    },
    ...(canWrite
      ? [
          {
            id: 'actions',
            header: () => <Trans>Actions</Trans>,
            cell: ({ row }: { row: { original: RolePermission } }) => (
              <div {...stylex.props(styles.actionGroup)}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingMapping(row.original)
                    setEditConditionText(
                      formatConditionExpression(row.original.condition_expression),
                    )
                    setEditConditionParse(null)
                  }}
                  {...stylex.props(styles.actionButton)}
                >
                  <Trans>Edit condition</Trans>
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setPendingDelete({ kind: 'mapping', value: row.original })}
                  {...stylex.props(styles.actionButton)}
                >
                  <Trans>Remove</Trans>
                </Button>
              </div>
            ),
            meta: { width: '190px' },
          } satisfies ColumnDef<RolePermission>,
        ]
      : []),
  ]

  const deletedRoleColumns: ColumnDef<ProjectRole>[] = [
    {
      id: 'role',
      header: () => <Trans>Role</Trans>,
      cell: ({ row }) => (
        <div>
          <div>{row.original.display_name}</div>
          <code {...stylex.props(styles.mono)}>{row.original.key}</code>
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
          isLoading={restoreRole.isPending && restoreRole.variables === row.original.id}
          onClick={() => void restoreRole.mutateAsync(row.original.id)}
          {...stylex.props(styles.actionButton)}
        >
          <Trans>Restore</Trans>
        </Button>
      ),
      meta: { width: '110px' },
    },
  ]

  const deletedPermissionColumns: ColumnDef<ProjectPermission>[] = [
    {
      id: 'permission',
      header: () => <Trans>Permission key</Trans>,
      cell: ({ row }) => <code {...stylex.props(styles.mono)}>{row.original.key}</code>,
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
          isLoading={restorePermission.isPending && restorePermission.variables === row.original.id}
          onClick={() => void restorePermission.mutateAsync(row.original.id)}
          {...stylex.props(styles.actionButton)}
        >
          <Trans>Restore</Trans>
        </Button>
      ),
      meta: { width: '110px' },
    },
  ]

  async function handleCreateRole(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!roleKey.trim() || !roleName.trim()) return
    const result = await createRole.mutateAsync({
      key: roleKey.trim(),
      display_name: roleName.trim(),
      group: roleGroup.trim() || undefined,
    })
    setRoleKey('')
    setRoleName('')
    setRoleGroup('')
    setSelectedRoleId(result.id)
  }

  async function handleCreatePermission(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!permissionKey.trim()) return
    await createPermission.mutateAsync({
      key: permissionKey.trim(),
      description: permissionDescription.trim() || undefined,
    })
    setPermissionKey('')
    setPermissionDescription('')
  }

  async function handleUpdateRole(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!editingRole || !editRoleName.trim()) return
    await updateRole.mutateAsync({
      id: editingRole.id,
      payload: {
        display_name: editRoleName.trim(),
        group: editRoleGroup.trim(),
      },
    })
    setEditingRole(null)
  }

  async function handleUpdatePermission(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!editingPermission) return
    await updatePermission.mutateAsync({
      id: editingPermission.id,
      payload: { description: editPermissionDescription.trim() },
    })
    setEditingPermission(null)
  }

  async function handleCreateMapping(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!mappingPermissionId || !roleId) return
    const parsed = parseConditionExpression(conditionText)
    setConditionParse(parsed)
    if (!parsed.ok) return
    await createMapping.mutateAsync({
      permission_id: mappingPermissionId,
      condition_expression: parsed.value,
    })
    setMappingPermissionId('')
    setConditionText('')
    setConditionParse(null)
  }

  async function handleUpdateMapping(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!editingMapping) return
    const parsed = parseConditionExpression(editConditionText)
    setEditConditionParse(parsed)
    if (!parsed.ok) return
    await updateMapping.mutateAsync({
      id: editingMapping.id,
      payload: { condition_expression: parsed.value },
    })
    setEditingMapping(null)
    setEditConditionParse(null)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    if (pendingDelete.kind === 'role') {
      await deleteRole.mutateAsync(pendingDelete.value.id)
    } else if (pendingDelete.kind === 'permission') {
      await deletePermission.mutateAsync(pendingDelete.value.id)
    } else {
      await deleteMapping.mutateAsync(pendingDelete.value.id)
    }
    setPendingDelete(null)
  }

  if (!orgId && !managed) {
    return (
      <div {...stylex.props(styles.message)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  const mutationError =
    createRole.error ??
    updateRole.error ??
    deleteRole.error ??
    restoreRole.error ??
    createPermission.error ??
    updatePermission.error ??
    deletePermission.error ??
    restorePermission.error ??
    createMapping.error ??
    updateMapping.error ??
    deleteMapping.error

  return (
    <div {...stylex.props(styles.root)}>
      {!embedded ? (
        <header {...stylex.props(styles.header)}>
          <h1 {...stylex.props(styles.title)}>
            <Trans>Roles and permissions</Trans>
          </h1>
          <p {...stylex.props(styles.lead)}>
            <Trans>
              Define project-local roles and permission keys, then connect them with optional ABAC
              conditions.
            </Trans>
          </p>
        </header>
      ) : null}

      {!managed ? (
        <div {...stylex.props(styles.toolbar)}>
          <div {...stylex.props(styles.toolbarField)}>
            <Field
              label={<Trans>Project</Trans>}
              hint={<Trans>Roles and permission keys never cross project boundaries.</Trans>}
            >
              <select
                value={projectId}
                onChange={(event) => {
                  setSelectedProjectId(event.currentTarget.value)
                  setSelectedRoleId('')
                  setMappingCursor(undefined)
                }}
                disabled={projects.isLoading || (projects.data?.data.length ?? 0) === 0}
                {...stylex.props(styles.select)}
              >
                {(projects.data?.data.length ?? 0) === 0 ? (
                  <option value="">{t`No active projects`}</option>
                ) : null}
                {(projects.data?.data ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {projects.data ? (
            <Pagination
              nextCursor={projects.data.next_cursor}
              loadMoreLabel={<Trans>Load more projects</Trans>}
              onLoadMore={setProjectCursor}
            />
          ) : null}
        </div>
      ) : null}

      {!managed && projects.isError ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="error">
            <Trans>Failed to load projects.</Trans>
          </Alert>
        </div>
      ) : null}

      {mutationError ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="error">{mutationError.message}</Alert>
        </div>
      ) : null}

      {!projectId ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="info">
            <Trans>Create an active project on the Projects page first.</Trans>
          </Alert>
        </div>
      ) : (
        <>
          <section aria-labelledby="rbac-resources-heading" {...stylex.props(styles.section)}>
            <h2 id="rbac-resources-heading" {...stylex.props(page.visuallyHidden)}>
              <Trans>Project roles and permissions</Trans>
            </h2>
            <div {...stylex.props(styles.split)}>
              <div {...stylex.props(styles.splitColumn)}>
                <div>
                  <h3 {...stylex.props(page.sectionLabel)}>
                    <Trans>Roles</Trans>
                  </h3>
                  <p {...stylex.props(styles.sectionDescription)}>
                    <Trans>
                      A stable role key groups permissions for token and API authorization.
                    </Trans>
                  </p>
                </div>
                {roles.isError ? (
                  <Alert tone="error">
                    <Trans>Failed to load roles.</Trans>
                  </Alert>
                ) : (
                  <>
                    <DataTable
                      columns={roleColumns}
                      data={roles.data?.data ?? []}
                      getRowId={(role) => role.id}
                      isLoading={roles.isLoading}
                      emptyMessage={<Trans>No active roles.</Trans>}
                    />
                    {roles.data ? (
                      <Pagination
                        nextCursor={roles.data.next_cursor}
                        loadMoreLabel={<Trans>Load more roles</Trans>}
                        onLoadMore={setRoleCursor}
                      />
                    ) : null}
                  </>
                )}
                {canWrite ? (
                  <form
                    onSubmit={(event) => void handleCreateRole(event)}
                    {...stylex.props(styles.sectionStack)}
                  >
                    <div {...stylex.props(styles.formGrid)}>
                      <Field label={<Trans>Role key</Trans>} required>
                        <Input
                          value={roleKey}
                          onChange={(event) => setRoleKey(event.currentTarget.value)}
                          placeholder={t`billing_admin`}
                        />
                      </Field>
                      <Field label={<Trans>Display name</Trans>} required>
                        <Input
                          value={roleName}
                          onChange={(event) => setRoleName(event.currentTarget.value)}
                        />
                      </Field>
                      <div {...stylex.props(styles.formWide)}>
                        <Field label={<Trans>Group</Trans>}>
                          <Input
                            value={roleGroup}
                            onChange={(event) => setRoleGroup(event.currentTarget.value)}
                            placeholder={t`Billing`}
                          />
                        </Field>
                      </div>
                    </div>
                    <div {...stylex.props(styles.formActions)}>
                      <Button
                        type="submit"
                        isLoading={createRole.isPending}
                        disabled={!roleKey.trim() || !roleName.trim()}
                      >
                        <Trans>Create role</Trans>
                      </Button>
                    </div>
                  </form>
                ) : null}
              </div>

              <div {...stylex.props(styles.splitColumn, styles.dividerColumn)}>
                <div>
                  <h3 {...stylex.props(page.sectionLabel)}>
                    <Trans>Permissions</Trans>
                  </h3>
                  <p {...stylex.props(styles.sectionDescription)}>
                    <Trans>
                      Permission keys are atomic actions such as invoice:read or invoice:write.
                    </Trans>
                  </p>
                </div>
                {permissions.isError ? (
                  <Alert tone="error">
                    <Trans>Failed to load permissions.</Trans>
                  </Alert>
                ) : (
                  <>
                    <DataTable
                      columns={permissionColumns}
                      data={permissions.data?.data ?? []}
                      getRowId={(permission) => permission.id}
                      isLoading={permissions.isLoading}
                      emptyMessage={<Trans>No active permissions.</Trans>}
                    />
                    {permissions.data ? (
                      <Pagination
                        nextCursor={permissions.data.next_cursor}
                        loadMoreLabel={<Trans>Load more permissions</Trans>}
                        onLoadMore={setPermissionCursor}
                      />
                    ) : null}
                  </>
                )}
                {canWrite ? (
                  <form
                    onSubmit={(event) => void handleCreatePermission(event)}
                    {...stylex.props(styles.sectionStack)}
                  >
                    <div {...stylex.props(styles.formGrid)}>
                      <Field label={<Trans>Permission key</Trans>} required>
                        <Input
                          value={permissionKey}
                          onChange={(event) => setPermissionKey(event.currentTarget.value)}
                          placeholder={t`invoice:read`}
                        />
                      </Field>
                      <Field label={<Trans>Description</Trans>}>
                        <Input
                          value={permissionDescription}
                          onChange={(event) => setPermissionDescription(event.currentTarget.value)}
                        />
                      </Field>
                    </div>
                    <div {...stylex.props(styles.formActions)}>
                      <Button
                        type="submit"
                        isLoading={createPermission.isPending}
                        disabled={!permissionKey.trim()}
                      >
                        <Trans>Create permission</Trans>
                      </Button>
                    </div>
                  </form>
                ) : null}
              </div>
            </div>
          </section>

          {canWrite && (editingRole || editingPermission) ? (
            <section aria-labelledby="edit-rbac-heading" {...stylex.props(styles.createSection)}>
              <div {...stylex.props(styles.sectionMeta)}>
                <h2 id="edit-rbac-heading" {...stylex.props(page.sectionLabel)}>
                  <Trans>Edit project RBAC</Trans>
                </h2>
                <p {...stylex.props(styles.sectionDescription)}>
                  <Trans>Stable keys cannot be changed after creation.</Trans>
                </p>
              </div>
              <div {...stylex.props(styles.controls)}>
                {editingRole ? (
                  <form
                    onSubmit={(event) => void handleUpdateRole(event)}
                    {...stylex.props(styles.sectionStack)}
                  >
                    <code {...stylex.props(styles.mono)}>{editingRole.key}</code>
                    <div {...stylex.props(styles.formGrid)}>
                      <Field label={<Trans>Display name</Trans>} required>
                        <Input
                          value={editRoleName}
                          onChange={(event) => setEditRoleName(event.currentTarget.value)}
                        />
                      </Field>
                      <Field label={<Trans>Group</Trans>}>
                        <Input
                          value={editRoleGroup}
                          onChange={(event) => setEditRoleGroup(event.currentTarget.value)}
                        />
                      </Field>
                    </div>
                    <div {...stylex.props(styles.formActions)}>
                      <Button
                        type="submit"
                        isLoading={updateRole.isPending}
                        disabled={!editRoleName.trim()}
                      >
                        <Trans>Save role</Trans>
                      </Button>
                      <Button variant="secondary" onClick={() => setEditingRole(null)}>
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </form>
                ) : null}
                {editingPermission ? (
                  <form
                    onSubmit={(event) => void handleUpdatePermission(event)}
                    {...stylex.props(styles.sectionStack)}
                  >
                    <code {...stylex.props(styles.mono)}>{editingPermission.key}</code>
                    <Field label={<Trans>Description</Trans>}>
                      <Input
                        value={editPermissionDescription}
                        onChange={(event) =>
                          setEditPermissionDescription(event.currentTarget.value)
                        }
                      />
                    </Field>
                    <div {...stylex.props(styles.formActions)}>
                      <Button type="submit" isLoading={updatePermission.isPending}>
                        <Trans>Save permission</Trans>
                      </Button>
                      <Button variant="secondary" onClick={() => setEditingPermission(null)}>
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </form>
                ) : null}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="mappings-heading" {...stylex.props(styles.createSection)}>
            <div {...stylex.props(styles.sectionMeta)}>
              <h2 id="mappings-heading" {...stylex.props(page.sectionLabel)}>
                <Trans>Role permission mappings</Trans>
              </h2>
              <p {...stylex.props(styles.sectionDescription)}>
                <Trans>
                  Select a role, attach a permission, and optionally require a JSON ABAC condition.
                  The server validates supported operators and variable paths.
                </Trans>
              </p>
            </div>
            <div {...stylex.props(styles.controls)}>
              <Field label={<Trans>Role</Trans>}>
                <select
                  value={roleId}
                  onChange={(event) => {
                    setSelectedRoleId(event.currentTarget.value)
                    setMappingCursor(undefined)
                  }}
                  disabled={(roles.data?.data.length ?? 0) === 0}
                  {...stylex.props(styles.select)}
                >
                  {(roles.data?.data.length ?? 0) === 0 ? (
                    <option value="">{t`No active roles`}</option>
                  ) : null}
                  {(roles.data?.data ?? []).map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.display_name} ({role.key})
                    </option>
                  ))}
                </select>
              </Field>
              {!roleId ? (
                <Alert tone="info">
                  <Trans>Create or select an active role first.</Trans>
                </Alert>
              ) : mappings.isError ? (
                <Alert tone="error">
                  <Trans>Failed to load role permission mappings.</Trans>
                </Alert>
              ) : (
                <>
                  <DataTable
                    columns={mappingColumns}
                    data={mappings.data?.data ?? []}
                    getRowId={(mapping) => mapping.id}
                    isLoading={mappings.isLoading}
                    emptyMessage={<Trans>No permissions mapped to this role.</Trans>}
                  />
                  {mappings.data ? (
                    <Pagination
                      nextCursor={mappings.data.next_cursor}
                      loadMoreLabel={<Trans>Load more role mappings</Trans>}
                      onLoadMore={setMappingCursor}
                    />
                  ) : null}
                  {canWrite ? (
                    <form
                      onSubmit={(event) => void handleCreateMapping(event)}
                      {...stylex.props(styles.sectionStack)}
                    >
                      <Field label={<Trans>Permission</Trans>} required>
                        <select
                          value={mappingPermissionId}
                          onChange={(event) => setMappingPermissionId(event.currentTarget.value)}
                          disabled={(permissions.data?.data.length ?? 0) === 0}
                          {...stylex.props(styles.select)}
                        >
                          <option value="">{t`Select permission`}</option>
                          {(permissions.data?.data ?? []).map((permission) => (
                            <option key={permission.id} value={permission.id}>
                              {permission.key}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label={<Trans>ABAC condition JSON</Trans>}
                        error={conditionErrorMessage(conditionParse)}
                        hint={
                          <Trans>
                            Leave blank for unconditional access. JSON must be an object; server
                            validation remains authoritative.
                          </Trans>
                        }
                      >
                        <textarea
                          value={conditionText}
                          onChange={(event) => {
                            setConditionText(event.currentTarget.value)
                            setConditionParse(null)
                          }}
                          placeholder={'{"op":"eq","var":"org.id","value":"org_..."}'}
                          {...stylex.props(
                            styles.textarea,
                            conditionParse && !conditionParse.ok && styles.textareaInvalid,
                          )}
                        />
                      </Field>
                      <div {...stylex.props(styles.formActions)}>
                        <Button
                          type="submit"
                          isLoading={createMapping.isPending}
                          disabled={!mappingPermissionId}
                        >
                          <Trans>Add mapping</Trans>
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </>
              )}
            </div>
          </section>

          {canWrite && editingMapping ? (
            <section aria-labelledby="edit-mapping-heading" {...stylex.props(styles.createSection)}>
              <div {...stylex.props(styles.sectionMeta)}>
                <h2 id="edit-mapping-heading" {...stylex.props(page.sectionLabel)}>
                  <Trans>Edit ABAC condition</Trans>
                </h2>
                <code {...stylex.props(styles.mono)}>{editingMapping.permission_id}</code>
              </div>
              <form
                onSubmit={(event) => void handleUpdateMapping(event)}
                {...stylex.props(styles.controls)}
              >
                <Field
                  label={<Trans>ABAC condition JSON</Trans>}
                  error={conditionErrorMessage(editConditionParse)}
                  hint={<Trans>Leave blank to make this mapping unconditional.</Trans>}
                >
                  <textarea
                    value={editConditionText}
                    onChange={(event) => {
                      setEditConditionText(event.currentTarget.value)
                      setEditConditionParse(null)
                    }}
                    {...stylex.props(
                      styles.textarea,
                      editConditionParse && !editConditionParse.ok && styles.textareaInvalid,
                    )}
                  />
                </Field>
                <div {...stylex.props(styles.formActions)}>
                  <Button type="submit" isLoading={updateMapping.isPending}>
                    <Trans>Save condition</Trans>
                  </Button>
                  <Button variant="secondary" onClick={() => setEditingMapping(null)}>
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
              </form>
            </section>
          ) : null}

          {canWrite ? (
            <section aria-labelledby="rbac-recycle-heading" {...stylex.props(styles.section)}>
              <div {...stylex.props(styles.sectionStack)}>
                <div>
                  <h2 id="rbac-recycle-heading" {...stylex.props(page.sectionLabel)}>
                    <Trans>RBAC recycle bin</Trans>
                  </h2>
                  <p {...stylex.props(styles.sectionDescription)}>
                    <Trans>
                      Soft-deleted roles and permissions remain visible across refreshes and can be
                      restored to this project.
                    </Trans>
                  </p>
                </div>
                <div {...stylex.props(styles.split)}>
                  <div {...stylex.props(styles.splitColumn)}>
                    <h3 {...stylex.props(page.sectionLabel)}>
                      <Trans>Deleted roles</Trans>
                    </h3>
                    {deletedRoles.isError ? (
                      <Alert tone="error">
                        <Trans>Failed to load deleted roles.</Trans>
                      </Alert>
                    ) : (
                      <>
                        <DataTable
                          columns={deletedRoleColumns}
                          data={deletedRoles.data?.data ?? []}
                          getRowId={(role) => role.id}
                          isLoading={deletedRoles.isLoading}
                          emptyMessage={<Trans>No deleted roles.</Trans>}
                        />
                        {deletedRoles.data ? (
                          <Pagination
                            nextCursor={deletedRoles.data.next_cursor}
                            loadMoreLabel={<Trans>Load more deleted roles</Trans>}
                            onLoadMore={setDeletedRoleCursor}
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                  <div {...stylex.props(styles.splitColumn, styles.dividerColumn)}>
                    <h3 {...stylex.props(page.sectionLabel)}>
                      <Trans>Deleted permissions</Trans>
                    </h3>
                    {deletedPermissions.isError ? (
                      <Alert tone="error">
                        <Trans>Failed to load deleted permissions.</Trans>
                      </Alert>
                    ) : (
                      <>
                        <DataTable
                          columns={deletedPermissionColumns}
                          data={deletedPermissions.data?.data ?? []}
                          getRowId={(permission) => permission.id}
                          isLoading={deletedPermissions.isLoading}
                          emptyMessage={<Trans>No deleted permissions.</Trans>}
                        />
                        {deletedPermissions.data ? (
                          <Pagination
                            nextCursor={deletedPermissions.data.next_cursor}
                            loadMoreLabel={<Trans>Load more deleted permissions</Trans>}
                            onLoadMore={setDeletedPermissionCursor}
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </>
      )}

      {canWrite && pendingDelete ? (
        <ConfirmDialog
          title={
            pendingDelete.kind === 'mapping' ? (
              <Trans>Remove role permission mapping?</Trans>
            ) : pendingDelete.kind === 'role' ? (
              <Trans>Delete role?</Trans>
            ) : (
              <Trans>Delete permission?</Trans>
            )
          }
          description={
            pendingDelete.kind === 'mapping' ? (
              <Trans>The role will no longer include this permission.</Trans>
            ) : (
              <Trans>
                This resource will stop authorizing access and move to the project recycle bin.
              </Trans>
            )
          }
          confirmLabel={
            pendingDelete.kind === 'mapping' ? <Trans>Remove mapping</Trans> : <Trans>Delete</Trans>
          }
          isLoading={deleteRole.isPending || deletePermission.isPending || deleteMapping.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  )
}
