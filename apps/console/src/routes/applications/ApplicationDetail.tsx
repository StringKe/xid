// 应用详情:头部(名称、类型、所属项目、client ID)+ 按客户端类型出现的设置区块,≥64rem 左侧区块目录。
// 机器对机器应用没有回调与登出区块;公开客户端没有 secret。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Link, useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Badge,
  Button,
  CopyButton,
  Dropdown,
  EmptyState,
  Icon,
  Skeleton,
  useToast,
} from '@xid-kit/web-ui/ui'
import { frame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { ORG_APPLICATIONS_PATH } from '../../nav'
import { useProjectsQuery } from '../org/queries'
import { withOrgId } from '../users/UsersList'
import type { AppRecord } from './app-api'
import { appKind, useApplication, useDeleteApplication, useProjectNames } from './app-api'
import { clientSummary, kindLabel, usesSharedSecret } from './app-format'
import { GrantsSection, RedirectsSection, SignOutSection } from './app-protocol-sections'
import { CredentialsSection, DetailsSection, SectionShell } from './app-sections'
import { RotateSecretDialog, SecretRevealDialog } from './SecretDialogs'
import { sections } from './section-styles'

function DangerZone({ app, onDelete }: { app: AppRecord; onDelete: () => void }): ReactNode {
  const name = app.name
  return (
    <SectionShell id="danger" title={<Trans>Danger zone</Trans>}>
      <div {...stylex.props(sections.danger)}>
        <div {...stylex.props(detail.itemMain)}>
          <span {...stylex.props(detail.itemTitle)}>
            <Trans>Delete {name}</Trans>
          </span>
          <span {...stylex.props(detail.itemSub)}>
            <Trans>
              Sign-ins and token requests from {name} stop. It can be restored later with the
              Management API.
            </Trans>
          </span>
        </div>
        <Button variant="danger" onClick={onDelete}>
          <Trans>Delete application…</Trans>
        </Button>
      </div>
    </SectionShell>
  )
}

export default function ApplicationDetail({ applicationId }: { applicationId: string }): ReactNode {
  const { t, i18n } = useLingui()
  const { notify } = useToast()
  const { activeOrg } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const errorMessage = useManagementErrorMessage()
  const app = useApplication(applicationId)
  const projects = useProjectsQuery(activeOrg?.id ?? '', 'active')
  const record = app.data
  const names = useProjectNames(record?.project_id ? [record.project_id] : [])
  const remove = useDeleteApplication(applicationId)
  const [rotating, setRotating] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const listPath = withOrgId(ORG_APPLICATIONS_PATH, location.search)
  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      <li>
        <Link to={listPath} {...stylex.props(frame.crumbLink)}>
          <Trans>Applications</Trans>
        </Link>
      </li>
      <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
        /
      </li>
      <li aria-current="page">{record?.name ?? <Skeleton width="6rem" height="0.75rem" />}</li>
    </ol>
  )

  if (app.isError && !record) {
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <EmptyState
          variant="load-failure"
          title={
            app.error.httpStatus === 404 ? (
              <Trans>Application not found</Trans>
            ) : (
              <Trans>Application could not be loaded</Trans>
            )
          }
          action={
            app.error.httpStatus === 404 ? null : (
              <Button variant="secondary" onClick={() => void app.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            )
          }
        />
      </div>
    )
  }
  if (!record) {
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <Skeleton width="16rem" height="2rem" />
      </div>
    )
  }

  const kind = appKind(record)
  const projectName = record.project_id ? (names.get(record.project_id) ?? record.project_id) : null
  const summary = clientSummary(i18n, record)
  const projectOptions = (projects.data?.data ?? []).map((project) => ({
    id: project.id,
    name: project.name,
  }))
  if (
    record.project_id &&
    projectName &&
    !projectOptions.some((option) => option.id === record.project_id)
  ) {
    projectOptions.push({ id: record.project_id, name: projectName })
  }
  const toc = [
    { id: 'details', label: t`Details` },
    { id: 'credentials', label: t`Credentials` },
    ...(kind === 'machine' ? [] : [{ id: 'redirects', label: t`Redirect URIs` }]),
    { id: 'grants', label: t`Grants and tokens` },
    ...(kind === 'machine' ? [] : [{ id: 'sign-out', label: t`Sign-out` }]),
    { id: 'danger', label: t`Danger zone` },
  ]
  const appName = record.name

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      <div {...stylex.props(detail.header)}>
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>{record.name}</h1>
            <Badge tone="neutral">{kindLabel(i18n, record)}</Badge>
          </div>
          <div {...stylex.props(detail.subRow)}>
            <span>
              {projectName ? (
                <Trans>
                  {summary} in the {projectName} project
                </Trans>
              ) : (
                summary
              )}
            </span>
            <span {...stylex.props(detail.idRow)}>
              <span {...stylex.props(detail.mono)}>{record.client_id}</span>
              <CopyButton value={record.client_id} subject={t`client ID`} />
            </span>
          </div>
        </div>
        <Dropdown
          ariaLabel={t`Actions for ${appName}`}
          align="end"
          triggerStyle={list.filterButton}
          trigger={({ open }) => (
            <>
              <Trans>Actions</Trans>
              <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
            </>
          )}
          items={[
            ...(usesSharedSecret(record)
              ? [
                  {
                    key: 'rotate',
                    label: <Trans>Rotate secret…</Trans>,
                    onSelect: () => setRotating(true),
                  },
                ]
              : []),
            {
              key: 'delete',
              label: <Trans>Delete application…</Trans>,
              tone: 'danger' as const,
              separatorBefore: usesSharedSecret(record),
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      </div>
      <div {...stylex.props(sections.layout)}>
        <ol {...stylex.props(sections.toc)}>
          {toc.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} {...stylex.props(sections.tocLink)}>
                {item.label}
              </a>
            </li>
          ))}
        </ol>
        <div {...stylex.props(sections.stack)}>
          <DetailsSection
            key={`details-${record.updated_at}`}
            app={record}
            projects={projectOptions}
          />
          <CredentialsSection app={record} onRotate={() => setRotating(true)} />
          {kind === 'machine' ? null : (
            <RedirectsSection key={`redirects-${record.updated_at}`} app={record} />
          )}
          <GrantsSection key={`grants-${record.updated_at}`} app={record} />
          {kind === 'machine' ? null : (
            <SignOutSection key={`signout-${record.updated_at}`} app={record} />
          )}
          <DangerZone app={record} onDelete={() => setDeleting(true)} />
        </div>
      </div>
      {rotating ? (
        <RotateSecretDialog
          app={record}
          onClose={() => setRotating(false)}
          onRotated={(value) => {
            setRotating(false)
            setSecret(value)
          }}
        />
      ) : null}
      {secret ? (
        <SecretRevealDialog
          appName={record.name}
          secret={secret}
          rotated
          onDone={() => setSecret(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={<Trans>Delete {appName}?</Trans>}
          description={<Trans>Sign-ins and token requests from {appName} stop right away.</Trans>}
          confirmLabel={<Trans>Delete application</Trans>}
          isLoading={remove.isPending}
          error={errorMessage(remove.error)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                notify({ title: t`${appName} was deleted` })
                navigate(listPath)
              },
            })
          }
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </div>
  )
}
