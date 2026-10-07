// 登录后的组织选择:按名称排序,超过一屏时显示搜索框并只列前 20 个;后端没有组织使用时间,不排「最近使用」。

import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { RequireAuth } from '@xid-kit/web-ui/RequireAuth'
import { Button, Field, Input, Notice, Spinner } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { AccountChip, initialsOf } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { OptionList } from '../../components/hosted/OptionList'
import { useAuth } from '../../lib/auth-context'
import { useRoleLabel } from '../../lib/enum-labels'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { trackOrganizationSelected } from '../../lib/google-analytics-funnel'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { normalizeLocalPath } from '@xid-kit/types'
import { filterOrganizations, VISIBLE_ORGANIZATION_LIMIT } from './organization-filter'

export function SelectOrganizationPage(): ReactNode {
  const search = useSearch({ strict: false }) as { authz_request_id?: string; redirect_to?: string }
  const defaultLandingPath = useDefaultLandingPath()
  const redirectTo =
    normalizeLocalPath(search.redirect_to) ??
    (search.authz_request_id
      ? `/authorize?authz_request_id=${encodeURIComponent(search.authz_request_id)}`
      : defaultLandingPath)
  const { organizations, setActiveOrganization, signOut, user } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const roleLabel = useRoleLabel()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingOrgId, setLoadingOrgId] = useState<string | null>(null)
  const visible = useMemo(() => filterOrganizations(organizations, query), [organizations, query])
  const searchable = organizations.length > VISIBLE_ORGANIZATION_LIMIT || query !== ''
  const above = user?.email ? <AccountChip label={user.email} name={user.name} /> : undefined
  const count = organizations.length

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
    navigate(redirectTo, { replace: true })
  }

  const footer = (
    <button type="button" onClick={() => void signOut()} {...stylex.props(hosted.textLink)}>
      <Trans>Sign out and use a different account</Trans>
    </button>
  )

  if (count === 0) {
    return (
      <AuthLayout footer={footer}>
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading
            above={above}
            title={<Trans>You're not in an organization yet</Trans>}
            lead={
              user?.canCreateOrganization ? (
                <Trans>Create one to continue, or ask an admin to invite you.</Trans>
              ) : (
                <Trans>Ask an organization admin to invite you, then sign in again.</Trans>
              )
            }
          />
          {user?.canCreateOrganization ? (
            <Button
              variant="accent"
              size="lg"
              fullWidth
              onClick={() => navigate('/create-organization')}
            >
              <Trans>Create organization</Trans>
            </Button>
          ) : null}
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout footer={footer}>
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          above={above}
          title={<Trans>Choose an organization</Trans>}
          lead={
            <Trans>
              You belong to {count} organizations. You'll continue in the one you choose.
            </Trans>
          }
        />
        {searchable ? (
          <Field label={<Trans>Find an organization</Trans>}>
            <Input
              type="search"
              inputSize="lg"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
          </Field>
        ) : null}
        {visible.length === 0 ? (
          <p {...stylex.props(hosted.note)}>
            <Trans>No organization matches "{query}".</Trans>
          </p>
        ) : (
          <OptionList
            label={t`Organizations`}
            items={visible.map((org) => ({
              key: org.id,
              title: org.name,
              description: roleLabel(org.role),
              monogram: initialsOf(org.name),
              disabled: loadingOrgId !== null,
              onSelect: () => void handleSelect(org.id),
            }))}
          />
        )}
        {loadingOrgId ? <Spinner label={t`Switching organization`} /> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
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
