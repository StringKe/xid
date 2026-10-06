import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { RequireAuth } from '@xid-kit/web-ui/RequireAuth'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { trackOrganizationCreated } from '../../lib/google-analytics-funnel'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { ACCOUNT_EXACT_PATH, type XidError } from '@xid-kit/types'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { page } from '../../styles/product-surface.stylex'

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
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

type CreateOrganizationErrors = {
  email?: string
  slug?: string
  form?: string
}

// 资格与 /v1/me canCreateOrganization 同源:不符合时不展示注定失败的表单。
function CreateOrganizationUnavailable({ onSignOut }: { onSignOut: () => void }): ReactNode {
  return (
    <AuthLayout
      footer={
        <button
          type="button"
          {...stylex.props(page.textLink, styles.textButton)}
          onClick={onSignOut}
        >
          <Trans>Sign out and use a different account</Trans>
        </button>
      }
    >
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={<Trans>Organization creation unavailable</Trans>}
          lead={
            <Trans>
              This account cannot create a new organization here. Ask an organization admin to
              invite you, or sign up with a new account to create your own organization.
            </Trans>
          }
        />
        <Link to={ACCOUNT_EXACT_PATH} {...stylex.props(page.textLink)}>
          <Trans>Go to account</Trans>
        </Link>
      </div>
    </AuthLayout>
  )
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
  // slug 默认跟随 name;用户手改后停止跟随。
  const [slugTouched, setSlugTouched] = useState(false)
  const [errors, setErrors] = useState<CreateOrganizationErrors>({})
  const [loading, setLoading] = useState(false)
  const apiErrorMessage = useApiErrorMessage()

  function describeError(error: XidError): CreateOrganizationErrors {
    const paramName = error.meta?.paramName
    if (error.code === 'already_exists' && paramName === 'slug') {
      return { slug: t`This URL slug is already taken. Choose another one.` }
    }
    if (error.code === 'validation_failed' && paramName === 'email') {
      return { email: t`Use the email address of the account you are signed in with.` }
    }
    if (error.code === 'validation_failed') {
      return {
        form: t`Enter an organization name and a URL slug made of lowercase letters, numbers, and hyphens.`,
      }
    }
    if (error.code === 'conflict') {
      return {
        form: t`This account cannot create a new organization. Ask an organization admin to invite you, or reload the page if you just changed accounts.`,
      }
    }
    return { form: apiErrorMessage(error, { surface: 'general' }) }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLoading(true)
    setErrors({})
    const result = await api.post<CreateOrgResponse>('/v1/organizations/self', {
      email: email.trim(),
      name: name.trim(),
      slug: slug.trim() || deriveSlug(name) || name.trim(),
    })
    setLoading(false)
    if (!result.ok) {
      setErrors(describeError(result.error))
      return
    }
    trackOrganizationCreated()
    await refresh()
    navigate(result.value.redirectUrl, { replace: true })
  }

  if (user && user.canCreateOrganization !== true) {
    return <CreateOrganizationUnavailable onSignOut={() => void signOut()} />
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
          error={errors.email}
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
          error={errors.slug}
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
        {errors.form ? <Alert tone="error">{errors.form}</Alert> : null}
        <Button
          type="submit"
          variant="accent"
          disabled={loading || email.trim() === '' || name.trim() === ''}
        >
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
