// 项目详情:Applications、Roles & permissions、Access、Managers、Settings 五个标签(写进 URL)。
// 组织管理员与该项目的 Project Manager 都能进入;项目授权管理者走 Managed projects。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { Link, useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Badge, Button, CopyButton, EmptyState, Skeleton, Tabs } from '@xid-kit/web-ui/ui'
import { frame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { ORG_PROJECTS_PATH } from '../../nav'
import OrgRoles from '../org/OrgRoles'
import { useApplications } from '../applications/app-api'
import { withOrgId } from '../users/UsersList'
import { ProjectAccessTab } from './ProjectAccessTab'
import { ProjectAppsTab, ProjectManagersTab, ProjectSettingsTab } from './ProjectTabs'
import { useProject } from './project-api'

const TABS = ['applications', 'roles', 'access', 'managers', 'settings'] as const
type TabKey = (typeof TABS)[number]

export default function ProjectDetail({ projectId }: { projectId: string }): ReactNode {
  const { t } = useLingui()
  const { activeOrg, managerAssignments } = useAuth()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const project = useProject(projectId)
  const apps = useApplications({ projectId })
  const record = project.data
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as TabKey)
    : 'applications'
  const managesProject = managerAssignments.some(
    (assignment) =>
      assignment.managerRole === 'project_manager' && assignment.scopeId === projectId,
  )
  const orgAdmin = activeOrg !== null && isOrgManagerRole(activeOrg.role)
  const canManage = managesProject || orgAdmin

  function selectTab(value: string): void {
    const next = new URLSearchParams(params)
    if (value === 'applications') next.delete('tab')
    else next.set('tab', value)
    const search = next.toString()
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true })
  }

  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      {orgAdmin ? (
        <>
          <li>
            <Link
              to={withOrgId(ORG_PROJECTS_PATH, location.search)}
              {...stylex.props(frame.crumbLink)}
            >
              <Trans>Projects</Trans>
            </Link>
          </li>
          <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
            /
          </li>
        </>
      ) : null}
      <li aria-current="page">{record?.name ?? <Skeleton width="6rem" height="0.75rem" />}</li>
    </ol>
  )

  if ((project.isError && !record) || record === null) {
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <EmptyState
          variant="load-failure"
          title={<Trans>Project not found</Trans>}
          description={<Trans>The project does not exist, or you do not manage it.</Trans>}
          action={
            project.isError ? (
              <Button variant="secondary" onClick={() => void project.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            ) : null
          }
        />
      </div>
    )
  }

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      {record ? (
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>{record.name}</h1>
            {record.status === 'deleted' ? (
              <Badge tone="neutral">
                <Trans>Deleted</Trans>
              </Badge>
            ) : null}
          </div>
          <div {...stylex.props(detail.subRow)}>
            {record.description ? <span>{record.description}</span> : null}
            <span {...stylex.props(detail.idRow)}>
              <span {...stylex.props(detail.mono)}>{record.id}</span>
              <CopyButton value={record.id} subject={t`project ID`} />
            </span>
          </div>
        </div>
      ) : (
        <Skeleton width="16rem" height="2rem" />
      )}
      <Tabs
        ariaLabel={t`Project sections`}
        value={tab}
        onValueChange={selectTab}
        items={[
          {
            value: 'applications',
            label: <Trans>Applications</Trans>,
            count: apps.data?.data.length,
          },
          { value: 'roles', label: <Trans>Roles & permissions</Trans> },
          { value: 'access', label: <Trans>Access</Trans> },
          { value: 'managers', label: <Trans>Managers</Trans> },
          { value: 'settings', label: <Trans>Settings</Trans> },
        ]}
      />
      {record && record.status === 'active' ? (
        <div {...stylex.props(detail.content)}>
          {tab === 'applications' ? (
            <ProjectAppsTab project={record} canManage={canManage} />
          ) : null}
          {tab === 'roles' ? (
            <OrgRoles managedProjectId={record.id} readOnly={!canManage} embedded />
          ) : null}
          {tab === 'access' ? <ProjectAccessTab project={record} canManage={canManage} /> : null}
          {tab === 'managers' ? <ProjectManagersTab project={record} canManage={orgAdmin} /> : null}
          {tab === 'settings' ? (
            <ProjectSettingsTab project={record} canManage={canManage} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
