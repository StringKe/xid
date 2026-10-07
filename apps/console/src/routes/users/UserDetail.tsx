// 用户详情:头部 + Actions(与列表行菜单同序)+ 六个标签(Profile、Sign-in methods、Organizations、
// Sessions、Activity、Raw JSON)。≥90rem 左侧 sticky 关键属性栏,以下移到头部下方并可收起。标签写进 URL。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link, useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import {
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  Dropdown,
  EmptyState,
  Icon,
  Skeleton,
  Tabs,
} from '@xid-kit/web-ui/ui'
import { PageFrame, frame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { ORG_USERS_PATH } from '../../nav'
import { initials } from '../../components/layout/nav-model'
import type { UserDetail as UserRecord } from './user-api'
import { useUser, useUserSessions, useUserSignInMethods } from './user-api'
import { formatDate, formatDateTime, statusBadge, userDisplayName } from './user-format'
import { UserActionDialogs, useUserActionState, userActionItems } from './UserActions'
import { withOrgId } from './UsersList'
import { ActivityTab } from './tabs/ActivityTab'
import { OrganizationsTab } from './tabs/OrganizationsTab'
import { ProfileTab, useSourceLabel } from './tabs/ProfileTab'
import { SessionsTab } from './tabs/SessionsTab'
import { SignInMethodsTab, useTwoStepSummary } from './tabs/SignInMethodsTab'

const TABS = ['profile', 'sign-in-methods', 'organizations', 'sessions', 'activity', 'raw'] as const
type TabKey = (typeof TABS)[number]

function KeyAttributes({ user }: { user: UserRecord }): ReactNode {
  const { t, i18n } = useLingui()
  const methods = useUserSignInMethods(user.id)
  const twoStep = useTwoStepSummary(methods.data)
  const source = useSourceLabel(user.source)
  const email = user.emails.find((row) => row.isPrimary)
  const phone = user.phones.find((row) => row.isPrimary)
  const created = formatDate(i18n, user.createdAt)
  const items: { key: string; label: string; value: ReactNode }[] = [
    { key: 'id', label: t`User ID`, value: <span {...stylex.props(detail.mono)}>{user.id}</span> },
    {
      key: 'email',
      label: t`Primary email`,
      value: email ? (
        <>
          {email.email}
          <br />
          <span {...stylex.props(email.verified ? detail.positive : detail.caution)}>
            {email.verified ? <Trans>Verified</Trans> : <Trans>Not verified</Trans>}
          </span>
        </>
      ) : (
        <span {...stylex.props(detail.muted)}>{t`None`}</span>
      ),
    },
    {
      key: 'phone',
      label: t`Phone`,
      value: phone?.phone ?? <span {...stylex.props(detail.muted)}>{t`None`}</span>,
    },
    {
      key: 'external',
      label: t`External ID`,
      value: user.externalId ? (
        <span {...stylex.props(detail.mono)}>{user.externalId}</span>
      ) : (
        <span {...stylex.props(detail.muted)}>{t`None`}</span>
      ),
    },
    {
      key: 'created',
      label: t`Created`,
      value: (
        <Trans>
          {created} by {source}
        </Trans>
      ),
    },
    {
      key: 'last',
      label: t`Last sign-in`,
      value: formatDateTime(i18n, user.lastLoginAt) ?? (
        <span {...stylex.props(detail.muted)}>{t`Never`}</span>
      ),
    },
    { key: 'mfa', label: t`Two-step verification`, value: twoStep },
  ]
  return (
    <dl {...stylex.props(detail.attrsList)}>
      {items.map((item) => (
        <div key={item.key} {...stylex.props(detail.attr)}>
          <dt {...stylex.props(detail.attrLabel)}>{item.label}</dt>
          <dd {...stylex.props(detail.attrValue)}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

const responsive = stylex.create({
  wideOnly: { display: { default: 'none', '@media (min-width: 90rem)': 'block' } },
  belowWide: { display: { default: 'block', '@media (min-width: 90rem)': 'none' } },
})

function Header({
  user,
  onAction,
}: {
  user: UserRecord
  onAction: Parameters<typeof userActionItems>[1]
}): ReactNode {
  const { t, i18n } = useLingui()
  const name = userDisplayName(i18n, user, user.isGuest)
  const badge = statusBadge(i18n, user.status, user.isGuest)
  const email = user.emails.find((row) => row.isPrimary)?.email ?? null
  const items = userActionItems({ id: user.id, name, email, status: user.status }, onAction)
  return (
    <div {...stylex.props(detail.header)}>
      <div {...stylex.props(detail.identity)}>
        <span aria-hidden="true" {...stylex.props(detail.avatar)}>
          {initials(name)}
        </span>
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>{name}</h1>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <div {...stylex.props(detail.subRow)}>
            {email ? <span>{email}</span> : null}
            <span {...stylex.props(detail.idRow)}>
              <span {...stylex.props(detail.mono)}>{user.id}</span>
              <CopyButton value={user.id} subject={t`user ID`} />
            </span>
          </div>
        </div>
      </div>
      {items.length > 0 ? (
        <Dropdown
          ariaLabel={t`Actions for ${name}`}
          align="end"
          triggerStyle={list.filterButton}
          trigger={({ open }) => (
            <>
              <Trans>Actions</Trans>
              <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
            </>
          )}
          items={items}
        />
      ) : null}
    </div>
  )
}

export default function UserDetail({ userId }: { userId: string }): ReactNode {
  const { t, i18n } = useLingui()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const user = useUser(userId)
  const sessions = useUserSessions(userId)
  const actions = useUserActionState()
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as TabKey)
    : 'profile'
  const record = user.data
  const name = record ? userDisplayName(i18n, record, record.isGuest) : ''
  const email = record?.emails.find((row) => row.isPrimary)?.email ?? null
  const sessionCount = sessions.data?.data.length
  const target = record
    ? { id: record.id, name, email, status: record.status, activeSessions: sessionCount }
    : null

  const resumedDelete = useRef(false)
  useEffect(() => {
    if (resumedDelete.current || params.get('confirm') !== 'delete' || !target) return
    resumedDelete.current = true
    actions.open(target, 'delete')
    const next = new URLSearchParams(params)
    next.delete('confirm')
    navigate(`${location.pathname}?${next.toString()}`, { replace: true })
  }, [params, target, actions, navigate, location.pathname])

  function selectTab(value: string): void {
    const next = new URLSearchParams(params)
    if (value === 'profile') next.delete('tab')
    else next.set('tab', value)
    const search = next.toString()
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true })
  }

  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      <li>
        <Link to={withOrgId(ORG_USERS_PATH, location.search)} {...stylex.props(frame.crumbLink)}>
          <Trans>Users</Trans>
        </Link>
      </li>
      <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
        /
      </li>
      <li aria-current="page">{record ? name : <Skeleton width="6rem" height="0.75rem" />}</li>
    </ol>
  )

  if (user.isError && !record) {
    return (
      <PageFrame title={<Trans>User</Trans>} breadcrumb={breadcrumb}>
        <EmptyState
          variant="load-failure"
          title={
            user.error.httpStatus === 404 ? (
              <Trans>User not found</Trans>
            ) : (
              <Trans>User could not be loaded</Trans>
            )
          }
          description={
            user.error.httpStatus === 404 ? (
              <Trans>The user does not exist in this tenant, or it was removed.</Trans>
            ) : (
              <Trans>Nothing changed. Check your connection and try again.</Trans>
            )
          }
          action={
            user.error.httpStatus === 404 ? null : (
              <Button variant="secondary" onClick={() => void user.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            )
          }
        />
      </PageFrame>
    )
  }

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      {record ? (
        <Header user={record} onAction={(action) => target && actions.open(target, action)} />
      ) : (
        <Skeleton width="16rem" height="2rem" />
      )}
      <Tabs
        ariaLabel={t`User sections`}
        value={tab}
        onValueChange={selectTab}
        items={[
          { value: 'profile', label: <Trans>Profile</Trans> },
          { value: 'sign-in-methods', label: <Trans>Sign-in methods</Trans> },
          { value: 'organizations', label: <Trans>Organizations</Trans> },
          { value: 'sessions', label: <Trans>Sessions</Trans>, count: sessionCount },
          { value: 'activity', label: <Trans>Activity</Trans> },
          { value: 'raw', label: <Trans>Raw JSON</Trans> },
        ]}
      />
      {record ? (
        <>
          <details open {...stylex.props(responsive.belowWide)}>
            <summary {...stylex.props(detail.attrsSummary)}>
              <Trans>Key attributes</Trans>
            </summary>
            <KeyAttributes user={record} />
          </details>
          <div {...stylex.props(detail.layout)}>
            <aside {...stylex.props(detail.attrs, responsive.wideOnly)}>
              <p {...stylex.props(detail.attrsTitle)}>
                <Trans>Key attributes</Trans>
              </p>
              <KeyAttributes user={record} />
            </aside>
            <div {...stylex.props(detail.content)}>
              {tab === 'profile' ? <ProfileTab user={record} name={name} /> : null}
              {tab === 'sign-in-methods' ? (
                <SignInMethodsTab
                  user={record}
                  name={name}
                  onAction={(action) => target && actions.open(target, action)}
                />
              ) : null}
              {tab === 'organizations' ? <OrganizationsTab user={record} name={name} /> : null}
              {tab === 'sessions' ? (
                <SessionsTab
                  user={record}
                  name={name}
                  sessions={sessions}
                  onSignOutEverywhere={() => target && actions.open(target, 'sign_out')}
                />
              ) : null}
              {tab === 'activity' ? <ActivityTab user={record} name={name} /> : null}
              {tab === 'raw' ? (
                <CodeBlock
                  code={JSON.stringify(record, null, 2)}
                  language="json"
                  subject={t`user JSON`}
                />
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      <UserActionDialogs
        action={actions.action}
        target={actions.target}
        onClose={actions.close}
        onDeleted={() => void user.refetch()}
      />
    </div>
  )
}
