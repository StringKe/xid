// org / platform 共用外壳(铁律 8 不另建 admin 壳):≥64rem 常驻 248px 侧栏,窄屏用顶栏 + 导航抽屉。
// nav 由路由按区域注入;作用域切换、命令菜单与全局提示条都在这里。

import { Trans, useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { isGuestUser, useAuth } from '@xid-kit/web-ui/session'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { Alert, Button, useCommandMenuShortcut } from '@xid-kit/web-ui/ui'
import {
  returnFromImpersonation,
  type ImpersonationEndResponse,
} from '../../lib/impersonation-handoff'
import { ActiveAnnouncementsBanner } from '../ActiveAnnouncementsBanner'
import type { ConsoleNavItem } from '../../nav'
import { MANAGED_PROJECTS_NAV_ITEM } from '../../nav'
import { ConsoleCommandMenu } from './ConsoleCommandMenu'
import { ConsoleNav } from './ConsoleNav'
import { ConsoleNavDrawer } from './ConsoleNavDrawer'
import { ConsoleTopBar } from './ConsoleTopBar'
import { ScopeSwitcher } from './ScopeSwitcher'
import { useDelegatedProjectItems, useNavCounts } from './nav-data'
import { isPlatformNav, navItemActive, navLabelText, visibleNavItems } from './nav-model'
import { nav as navStyles, shell as styles } from './shell-styles'

export type { ConsoleNavItem } from '../../nav'

export type ConsoleLayoutProps = {
  children: ReactNode
  navItems: readonly ConsoleNavItem[]
}

function GlobalBands({
  ending,
  endFailed,
  onEndImpersonation,
}: {
  ending: boolean
  endFailed: boolean
  onEndImpersonation: () => void
}): ReactNode {
  const { t } = useLingui()
  const { user, session, openEmailVerification } = useAuth()
  const impersonating = session?.isImpersonation === true

  return (
    <>
      {impersonating ? (
        <section aria-label={t`Impersonation session`} {...stylex.props(styles.band)}>
          <div {...stylex.props(styles.bandRow)}>
            <div {...stylex.props(styles.bandMessage)}>
              <Alert tone="warning" title={<Trans>Impersonation session</Trans>}>
                <Trans>
                  You are viewing this organization as another user. Management changes are
                  disabled.
                </Trans>
              </Alert>
              {endFailed ? (
                <Alert tone="error">
                  <Trans>The impersonation session could not be ended. Try again.</Trans>
                </Alert>
              ) : null}
            </div>
            <Button variant="secondary" isLoading={ending} onClick={onEndImpersonation}>
              <Trans>End impersonation</Trans>
            </Button>
          </div>
        </section>
      ) : null}
      {user && !user.emailVerified && !isGuestUser(user) && !impersonating ? (
        <section aria-label={t`Email verification required`} {...stylex.props(styles.band)}>
          <div {...stylex.props(styles.bandRow)}>
            <div {...stylex.props(styles.bandMessage)}>
              <Alert tone="warning" title={<Trans>Console is read-only</Trans>}>
                {user.email ? (
                  <Trans>Verify {user.email} before creating or changing resources.</Trans>
                ) : (
                  <Trans>Verify your email before creating or changing resources.</Trans>
                )}
              </Alert>
            </div>
            <Button variant="secondary" onClick={openEmailVerification}>
              <Trans>Verify email</Trans>
            </Button>
          </div>
        </section>
      ) : null}
      {isGuestUser(user) && !impersonating ? (
        <section aria-label={t`Guest account`} {...stylex.props(styles.band)}>
          <div {...stylex.props(styles.bandRow)}>
            <div {...stylex.props(styles.bandMessage)}>
              <Alert tone="warning" title={<Trans>Guest account</Trans>}>
                <Trans>
                  You are signed in as a guest. Set up a sign-in method to keep this account and its
                  data; signing out discards it.
                </Trans>
              </Alert>
            </div>
            <Button variant="secondary" onClick={() => window.location.assign('/account/security')}>
              <Trans>Set up sign-in method</Trans>
            </Button>
          </div>
        </section>
      ) : null}
    </>
  )
}

export function ConsoleLayout({ children, navItems }: ConsoleLayoutProps): ReactNode {
  const { i18n } = useLingui()
  const auth = useAuth()
  const { status, user, activeOrg, managerAssignments, session, api } = auth
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchFailed, setSwitchFailed] = useState(false)
  const [ending, setEnding] = useState(false)
  const [endFailed, setEndFailed] = useState(false)
  useCommandMenuShortcut(useCallback(() => setSearchOpen(true), []))

  const platform = isPlatformNav(navItems)
  const managesActiveOrg = activeOrg !== null && isOrgManagerRole(activeOrg.role)
  const delegated = useDelegatedProjectItems(managerAssignments)
  const base = visibleNavItems({
    navItems,
    activeOrg,
    hasManagerAssignments: managerAssignments.length > 0,
  })
  const hasGrantScopes = managerAssignments.some((item) => item.managerRole !== 'project_manager')
  const items: readonly ConsoleNavItem[] =
    platform || managesActiveOrg
      ? base
      : [...delegated, ...(hasGrantScopes ? [MANAGED_PROJECTS_NAV_ITEM] : [])]
  const counts = useNavCounts(activeOrg, items)
  const current = items.find((item) => navItemActive(location.pathname, item))
  const impersonating = session?.isImpersonation === true
  const scopeDisabled = status !== 'authenticated' || switching || impersonating

  async function switchOrganization(organizationId: string): Promise<void> {
    if (!organizationId || organizationId === activeOrg?.id) return
    setSwitching(true)
    setSwitchFailed(false)
    const switched = await auth.setActiveOrganization(organizationId)
    setSwitching(false)
    if (!switched) {
      setSwitchFailed(true)
      return
    }
    // org 区切换落到 overview;其他区保留当前路径,避免上下文被硬切。
    if (location.pathname.startsWith('/console/org')) {
      navigate(`/console/org?orgId=${encodeURIComponent(organizationId)}`, { replace: true })
    }
  }

  async function endImpersonation(): Promise<void> {
    if (ending) return
    setEnding(true)
    setEndFailed(false)
    const ended = await api.post<ImpersonationEndResponse>('/auth/impersonation/end')
    if (ended.ok) {
      if (!returnFromImpersonation(ended.value.redirectUrl)) {
        await auth.refresh()
        navigate('/console', { replace: true })
      }
    } else {
      setEndFailed(true)
    }
    setEnding(false)
  }

  const accountActions = {
    onSignOut: () => void auth.signOut(),
    ...(impersonating ? { onEndImpersonation: () => void endImpersonation() } : {}),
  }
  const navList = (onNavigate?: () => void) => (
    <ConsoleNav items={items} counts={counts} backToConsole={platform} onNavigate={onNavigate} />
  )

  return (
    <div
      data-smoke-authenticated-console={status === 'authenticated' ? 'true' : undefined}
      {...stylex.props(styles.root)}
    >
      <aside {...stylex.props(styles.aside)}>
        <div {...stylex.props(styles.asidePin)}>
          <div {...stylex.props(navStyles.scopeRow)}>
            <ScopeSwitcher
              disabled={scopeDisabled}
              onSwitch={(id) => void switchOrganization(id)}
            />
          </div>
          <div {...stylex.props(navStyles.region)}>{navList()}</div>
        </div>
      </aside>
      <div {...stylex.props(styles.workspace)}>
        <ConsoleTopBar
          user={user}
          sectionLabel={current ? navLabelText(i18n, current.label) : null}
          scopeDisabled={scopeDisabled}
          onSwitchOrganization={(id) => void switchOrganization(id)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenMenu={() => setMenuOpen(true)}
          {...accountActions}
        />
        <main {...stylex.props(styles.main)}>
          <ActiveAnnouncementsBanner enabled={status === 'authenticated'} />
          {switchFailed ? (
            <section {...stylex.props(styles.band)}>
              <Alert tone="error">
                <Trans>
                  Could not switch organization. Try again or choose another organization.
                </Trans>
              </Alert>
            </section>
          ) : null}
          <GlobalBands
            ending={ending}
            endFailed={endFailed}
            onEndImpersonation={() => void endImpersonation()}
          />
          {children}
        </main>
      </div>
      <ConsoleNavDrawer
        open={menuOpen}
        onOpenChange={setMenuOpen}
        user={user}
        scopeDisabled={scopeDisabled}
        onSwitchOrganization={(id) => {
          setMenuOpen(false)
          void switchOrganization(id)
        }}
        {...accountActions}
      >
        {navList(() => setMenuOpen(false))}
      </ConsoleNavDrawer>
      <ConsoleCommandMenu
        open={searchOpen}
        onOpenChange={setSearchOpen}
        navItems={items}
        search={location.search}
      />
    </div>
  )
}
