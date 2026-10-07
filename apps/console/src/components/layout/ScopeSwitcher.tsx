// 作用域切换器:当前组织 + 可管理组织列表(带检索)、受托项目、新建组织、组织设置与平台入口。
// 模拟会话里锁定组织,不允许切换。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import type { AuthOrg } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { Icon, Popover } from '@xid-kit/web-ui/ui'
import { useManagedProjectQuery } from '../../routes/org/queries'
import { firstLetter } from './nav-model'
import { scope as styles } from './scope-styles'

function ProjectEntry({
  projectId,
  onSelect,
}: {
  projectId: string
  onSelect: () => void
}): ReactNode {
  const project = useManagedProjectQuery(projectId)
  const name = project.data?.data[0]?.name ?? projectId
  return (
    <Link
      to={`/console/org/projects/${projectId}`}
      onClick={onSelect}
      {...stylex.props(styles.row)}
    >
      <span aria-hidden="true" {...stylex.props(styles.rowMark)}>
        {firstLetter(name)}
      </span>
      <span {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowName)}>{name}</span>
        <span {...stylex.props(styles.rowSub)}>
          <Trans>Project manager</Trans>
        </span>
      </span>
    </Link>
  )
}

function OrganizationRow({
  org,
  parentName,
  current,
  onSelect,
}: {
  org: AuthOrg
  parentName: ReactNode | null
  current: boolean
  onSelect: () => void
}): ReactNode {
  const role = useRoleLabel()(org.role)
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={onSelect}
      {...stylex.props(styles.row, current && styles.rowCurrent)}
    >
      <span aria-hidden="true" {...stylex.props(styles.rowMark, current && styles.rowMarkCurrent)}>
        {firstLetter(org.name ?? org.slug)}
      </span>
      <span {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowName)}>{organizationDisplayName(org)}</span>
        <span {...stylex.props(styles.rowSub)}>
          {parentName ? (
            <Trans>
              {role}, sub-organization of {parentName}
            </Trans>
          ) : (
            role
          )}
        </span>
      </span>
      {current ? (
        <span {...stylex.props(styles.currentTag)}>
          <Trans>Current</Trans>
        </span>
      ) : null}
    </button>
  )
}

export type ScopeSwitcherProps = {
  disabled: boolean
  onSwitch: (organizationId: string) => void
  compact?: boolean
}

export function ScopeSwitcher({
  disabled,
  onSwitch,
  compact = false,
}: ScopeSwitcherProps): ReactNode {
  const { t } = useLingui()
  const { activeOrg, organizations, managerAssignments, user } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const manageable = organizations.filter((org) => isOrgManagerRole(org.role))
  const needle = query.trim().toLowerCase()
  const matches = manageable.filter(
    (org) =>
      needle === '' ||
      org.name.toLowerCase().includes(needle) ||
      org.slug.toLowerCase().includes(needle),
  )
  const delegatedProjects = managerAssignments.filter(
    (assignment) =>
      assignment.managerRole === 'project_manager' && assignment.scopeStatus === 'active',
  )
  const nameById = new Map(organizations.map((org) => [org.id, org]))
  const close = () => setOpen(false)
  const title = activeOrg ? organizationDisplayName(activeOrg) : <Trans>Select organization</Trans>

  const trigger = (
    <button
      type="button"
      aria-label={t`Switch organization`}
      disabled={disabled}
      {...stylex.props(styles.trigger, compact && styles.triggerCompact)}
    >
      {compact ? null : (
        <span aria-hidden="true" {...stylex.props(styles.mark)}>
          {activeOrg ? (
            firstLetter(activeOrg.name ?? activeOrg.slug)
          ) : (
            <Icon name="building" size={14} />
          )}
        </span>
      )}
      <span {...stylex.props(styles.triggerText)}>
        <span {...stylex.props(styles.triggerName, compact && styles.triggerNameCompact)}>
          {title}
        </span>
        {compact || !activeOrg ? null : (
          <span {...stylex.props(styles.triggerSub)}>{activeOrg.slug}</span>
        )}
      </span>
      <span aria-hidden="true" {...stylex.props(styles.chevron)}>
        <Icon name="chevrons-up-down" size={compact ? 12 : 16} />
      </span>
    </button>
  )

  return (
    <Popover trigger={trigger} side="bottom" align="start" open={open} onOpenChange={setOpen}>
      <div {...stylex.props(styles.panel)}>
        <label {...stylex.props(styles.search)}>
          <span aria-hidden="true" {...stylex.props(styles.searchIcon)}>
            <Icon name="search" size={16} />
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t`Find an organization`}
            aria-label={t`Find an organization`}
            {...stylex.props(styles.searchInput)}
          />
        </label>
        {manageable.length > 0 ? (
          <div {...stylex.props(styles.section)}>
            <p {...stylex.props(styles.sectionLabel)}>
              <Trans>Organizations you manage</Trans>
            </p>
            {matches.map((org) => {
              const parent = org.parentOrgId ? nameById.get(org.parentOrgId) : undefined
              return (
                <OrganizationRow
                  key={org.id}
                  org={org}
                  current={org.id === activeOrg?.id}
                  parentName={parent ? organizationDisplayName(parent) : null}
                  onSelect={() => {
                    close()
                    onSwitch(org.id)
                  }}
                />
              )
            })}
            {matches.length === 0 ? (
              <p {...stylex.props(styles.empty)}>
                <Trans>No organization matches {query}.</Trans>
              </p>
            ) : null}
          </div>
        ) : null}
        {delegatedProjects.length > 0 ? (
          <div {...stylex.props(styles.section)}>
            <p {...stylex.props(styles.sectionLabel)}>
              <Trans>Projects you manage</Trans>
            </p>
            {delegatedProjects.map((assignment) => (
              <ProjectEntry key={assignment.id} projectId={assignment.scopeId} onSelect={close} />
            ))}
          </div>
        ) : null}
        {user?.canCreateOrganization ? (
          <a href="/create-organization" {...stylex.props(styles.row)}>
            <span aria-hidden="true" {...stylex.props(styles.rowIcon)}>
              <Icon name="plus" size={16} />
            </span>
            <span {...stylex.props(styles.rowName)}>
              <Trans>Create organization…</Trans>
            </span>
          </a>
        ) : null}
        {activeOrg && isOrgManagerRole(activeOrg.role) ? (
          <div {...stylex.props(styles.divided)}>
            <button
              type="button"
              onClick={() => {
                close()
                navigate('/console/settings')
              }}
              {...stylex.props(styles.row)}
            >
              <span aria-hidden="true" {...stylex.props(styles.rowIcon)}>
                <Icon name="gear" size={16} />
              </span>
              <span {...stylex.props(styles.rowText)}>
                <span {...stylex.props(styles.rowName)}>
                  <Trans>Organization settings</Trans>
                </span>
                <span {...stylex.props(styles.rowSub)}>
                  <Trans>Every setting for {title} in one list</Trans>
                </span>
              </span>
            </button>
          </div>
        ) : null}
        {user?.instanceManager ? (
          <div {...stylex.props(styles.divided)}>
            <Link to="/console/platform" onClick={close} {...stylex.props(styles.row)}>
              <span aria-hidden="true" {...stylex.props(styles.rowIcon)}>
                <Icon name="squares-four" size={16} />
              </span>
              <span {...stylex.props(styles.rowText)}>
                <span {...stylex.props(styles.rowName)}>
                  <Trans>Platform</Trans>
                </span>
                <span {...stylex.props(styles.rowSub)}>
                  <Trans>Instance manager</Trans>
                </span>
              </span>
            </Link>
          </div>
        ) : null}
      </div>
    </Popover>
  )
}
