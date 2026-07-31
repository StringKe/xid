import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { RequireAuth } from '../../components/RequireAuth'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackOrganizationSelected } from '../../lib/google-analytics-funnel'
import { useNavigate } from '../../lib/router'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    minWidth: 0,
  },
  orgButton: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.25rem',
    width: '100%',
    textAlign: 'left',
  },
  orgName: {
    fontWeight: 600,
  },
  orgMeta: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
  },
  // button 形态的行内文本链接:重置 button 默认外观,与 page.textLink 叠加使用。
  textButton: {
    alignSelf: 'flex-start',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
})

export function SelectOrganizationPage(): ReactNode {
  const search = useSearch({ strict: false }) as {
    authz_request_id?: string
    redirect_to?: string
  }
  const redirectTo =
    search.redirect_to ??
    (search.authz_request_id
      ? `/authorize?authz_request_id=${encodeURIComponent(search.authz_request_id)}`
      : '/console')
  const { organizations, setActiveOrganization, signOut } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const [error, setError] = useState<string | null>(null)
  const [loadingOrgId, setLoadingOrgId] = useState<string | null>(null)

  async function handleSelect(organizationId: string): Promise<void> {
    setLoadingOrgId(organizationId)
    setError(null)
    const ok = await setActiveOrganization(organizationId)
    setLoadingOrgId(null)
    if (!ok) {
      setError(t`Could not switch organization. Try again.`)
      return
    }
    trackOrganizationSelected()
    const safeRedirect =
      redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : '/console'
    navigate(safeRedirect, { replace: true })
  }

  // 此页不接 steps:它是老用户登录后的组织切换点,不属于线性 onboarding 向导。
  const footer = (
    <button
      type="button"
      {...stylex.props(page.textLink, styles.textButton)}
      onClick={() => void signOut()}
    >
      <Trans>Sign out and use a different account</Trans>
    </button>
  )

  if (organizations.length === 0) {
    return (
      <AuthLayout footer={footer}>
        <div {...stylex.props(styles.stack)}>
          <PageHeader
            title={<Trans>Select organization</Trans>}
            lead={
              <Trans>Choose which organization to use for this sign-in before continuing.</Trans>
            }
          />
          <Alert tone="warning">
            <Trans>You do not belong to any organizations yet.</Trans>
          </Alert>
          <Button type="button" fullWidth onClick={() => navigate('/create-organization')}>
            <Trans>Create organization</Trans>
          </Button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout footer={footer}>
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={<Trans>Select organization</Trans>}
          lead={<Trans>Choose which organization to use for this sign-in before continuing.</Trans>}
        />
        {organizations.map((org) => (
          <Button
            key={org.id}
            type="button"
            variant="secondary"
            disabled={loadingOrgId !== null}
            onClick={() => void handleSelect(org.id)}
            {...stylex.props(styles.orgButton)}
          >
            <span {...stylex.props(styles.orgName)}>{org.name}</span>
            <span {...stylex.props(styles.orgMeta)}>{org.slug}</span>
          </Button>
        ))}
        {loadingOrgId ? <Spinner label={t`Switching organization`} /> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/select-organization')({
  component: () => (
    <RequireAuth>
      <SelectOrganizationPage />
    </RequireAuth>
  ),
})
