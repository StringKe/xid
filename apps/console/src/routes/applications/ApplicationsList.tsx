// 租户里所有应用的扁平列表:名称或 client ID 检索、类型与项目筛选;创建后共享 secret 只显示一次。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { Button, Dropdown, EmptyState, Icon } from '@xid-kit/web-ui/ui'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { ORG_APPLICATIONS_PATH } from '../../nav'
import { useProjectsQuery } from '../org/queries'
import { withOrgId } from '../users/UsersList'
import type { AppKind, AppRecord, CreatedApp } from './app-api'
import { appKind, useApplications, useProjectNames } from './app-api'
import { KIND_LABELS } from './app-format'
import { AppsTable } from './AppsTable'
import { CreateApplicationDialog } from './CreateApplicationDialog'
import { SecretRevealDialog } from './SecretDialogs'

const KINDS: readonly AppKind[] = ['web', 'spa', 'native', 'machine', 'device']

export default function ApplicationsList(): ReactNode {
  const { t, i18n } = useLingui()
  const { activeOrg } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const apps = useApplications()
  const projects = useProjectsQuery(activeOrg?.id ?? '', 'active')
  const rows = apps.data?.data ?? []
  const names = useProjectNames(
    rows.map((app) => app.project_id).filter((id): id is string => id !== null),
  )
  for (const project of projects.data?.data ?? []) names.set(project.id, project.name)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AppKind | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedApp | null>(null)
  const needle = query.trim().toLowerCase()
  const shown = rows.filter(
    (app) =>
      (kind === null || appKind(app) === kind) &&
      (projectId === null || app.project_id === projectId) &&
      (needle === '' ||
        app.name.toLowerCase().includes(needle) ||
        app.client_id.toLowerCase().includes(needle)),
  )
  const projectCount = new Set(rows.map((app) => app.project_id).filter(Boolean)).size
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''
  const open = (app: Pick<AppRecord, 'id'>) =>
    navigate(withOrgId(`${ORG_APPLICATIONS_PATH}/${app.id}`, location.search))
  const appCount = rows.length

  return (
    <PageFrame
      title={<Trans>Applications</Trans>}
      lead={
        <Trans>
          Every app that signs users in to {orgName} or calls its APIs through XID, across all
          projects.
        </Trans>
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
            placeholder={t`Name or client ID`}
            aria-label={t`Search applications`}
            {...stylex.props(list.searchInput)}
          />
        </label>
        <Dropdown
          ariaLabel={t`Type`}
          align="start"
          triggerStyle={list.filterButton}
          trigger={
            <>
              <span>{t`Type`}</span>
              {kind ? (
                <span {...stylex.props(list.filterValue)}>{i18n._(KIND_LABELS[kind])}</span>
              ) : null}
              <Icon name="caret-down" size={12} />
            </>
          }
          items={[
            { key: 'any', label: t`Any`, checked: kind === null, onSelect: () => setKind(null) },
            ...KINDS.map((option) => ({
              key: option,
              label: i18n._(KIND_LABELS[option]),
              checked: kind === option,
              onSelect: () => setKind(option),
            })),
          ]}
        />
        <span {...stylex.props(list.hideNarrow)}>
          <Dropdown
            ariaLabel={t`Project`}
            align="start"
            triggerStyle={list.filterButton}
            trigger={
              <>
                <span>{t`Project`}</span>
                {projectId ? (
                  <span {...stylex.props(list.filterValue)}>
                    {names.get(projectId) ?? projectId}
                  </span>
                ) : null}
                <Icon name="caret-down" size={12} />
              </>
            }
            items={[
              {
                key: 'any',
                label: t`Any`,
                checked: projectId === null,
                onSelect: () => setProjectId(null),
              },
              ...[...names.entries()].map(([id, name]) => ({
                key: id,
                label: name,
                checked: projectId === id,
                onSelect: () => setProjectId(id),
              })),
            ]}
          />
        </span>
        <div {...stylex.props(list.barEnd)}>
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            <Trans>Create application…</Trans>
          </Button>
        </div>
      </div>
      {apps.data ? (
        <div {...stylex.props(list.summaryRow)}>
          <span {...stylex.props(list.summary)}>
            <Trans>
              <Plural value={appCount} one="# application" other="# applications" /> in{' '}
              <Plural value={projectCount} one="# project" other="# projects" />
            </Trans>
          </span>
        </div>
      ) : null}
      {apps.isError && !apps.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Applications could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void apps.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : apps.data && rows.length === 0 ? (
        <EmptyState
          variant="first-use"
          title={<Trans>No applications yet</Trans>}
          description={
            <Trans>
              Register the first app that signs users in through XID. Each app gets a client ID; web
              apps and machine-to-machine clients also get a secret.
            </Trans>
          }
          action={
            <Button onClick={() => setCreating(true)}>
              <Trans>Create application…</Trans>
            </Button>
          }
        />
      ) : (
        <AppsTable
          apps={shown}
          isLoading={apps.isLoading}
          projectNames={names}
          showProject
          onOpen={open}
          emptyMessage={<Trans>No applications match these filters.</Trans>}
        />
      )}
      {creating ? (
        <CreateApplicationDialog
          projects={(projects.data?.data ?? []).map((project) => ({
            id: project.id,
            name: project.name,
          }))}
          requireProject={false}
          onClose={() => setCreating(false)}
          onCreated={(app) => {
            setCreating(false)
            if (app.client_secret) setCreated(app)
            else open(app)
          }}
        />
      ) : null}
      {created?.client_secret ? (
        <SecretRevealDialog
          appName={created.name}
          secret={created.client_secret}
          rotated={false}
          onDone={() => {
            const app = created
            setCreated(null)
            open(app)
          }}
        />
      ) : null}
    </PageFrame>
  )
}
