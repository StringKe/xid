import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { RequireAuth } from '../../components/RequireAuth'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { trackOrganizationCreated } from '../../lib/google-analytics-funnel'
import { useNavigate } from '../../lib/router'
import { page } from '../../styles/product-surface.stylex'

const styles = stylex.create({
  // 卡片内主栈:对齐 sign-in 密度(1.25rem)。
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
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

type CreateOrgResponse = {
  id: string
  slug: string
  name: string
  role: string
  redirectUrl: string
}

function deriveSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
}

export function CreateOrganizationPage(): ReactNode {
  const { api, refresh, signOut, user } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const isGuest = isGuestUser(user)
  const existingEmail = !isGuest ? (user?.email.trim() ?? '') : ''
  const [email, setEmail] = useState(existingEmail)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  // slug 默认跟随 name 派生;用户手动改过 slug 后停止跟随。
  const [slugTouched, setSlugTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLoading(true)
    setError(null)
    const result = await api.post<CreateOrgResponse>('/v1/organizations/self', {
      email: email.trim(),
      name: name.trim(),
      slug: slug.trim() || deriveSlug(name) || name.trim(),
    })
    setLoading(false)
    if (!result.ok) {
      setError(t`Could not create organization. Check the email and slug, then try again.`)
      return
    }
    trackOrganizationCreated()
    await refresh()
    navigate(result.value.redirectUrl, { replace: true })
  }

  return (
    <AuthLayout
      steps={{ current: 2, total: 2, label: <Trans>Organization</Trans> }}
      footer={
        <button
          type="button"
          {...stylex.props(page.textLink, styles.textButton)}
          onClick={() => void signOut()}
        >
          <Trans>Sign out and use a different account</Trans>
        </button>
      }
    >
      <form onSubmit={(event) => void handleSubmit(event)} {...stylex.props(styles.stack)}>
        <PageHeader
          title={<Trans>Create your organization</Trans>}
          lead={
            <Trans>
              Set up an organization to manage members, authentication, and applications.
            </Trans>
          }
        />
        <Field
          label={<Trans>Email</Trans>}
          hint={
            isGuest ? (
              <Trans>
                Verify this address to secure your account. You can recover your account with it
                after verifying.
              </Trans>
            ) : existingEmail ? (
              <Trans>This email belongs to your signed-in account.</Trans>
            ) : (
              <Trans>You can verify this address from the Console.</Trans>
            )
          }
          required
        >
          <Input
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            readOnly={existingEmail !== ''}
            autoComplete="email"
          />
        </Field>
        <Field label={<Trans>Organization name</Trans>} required>
          <Input
            name="organization-name"
            value={name}
            onChange={(event) => {
              const next = event.target.value
              setName(next)
              if (!slugTouched) setSlug(deriveSlug(next))
            }}
            required
            autoComplete="organization"
          />
        </Field>
        <Field
          label={<Trans>URL slug</Trans>}
          hint={
            <Trans>Used in URLs and subdomains. Lowercase letters, numbers, and hyphens.</Trans>
          }
        >
          <Input
            name="organization-slug"
            value={slug}
            onChange={(event) => {
              setSlugTouched(true)
              setSlug(event.target.value)
            }}
            placeholder={deriveSlug(name)}
            autoComplete="off"
          />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={loading || email.trim() === '' || name.trim() === ''}>
          {loading ? <Trans>Creating…</Trans> : <Trans>Create organization</Trans>}
        </Button>
      </form>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/create-organization')({
  component: () => (
    <RequireAuth>
      <CreateOrganizationPage />
    </RequireAuth>
  ),
})
