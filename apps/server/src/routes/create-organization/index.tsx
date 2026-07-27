import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { RequireAuth } from '../../components/RequireAuth'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackOrganizationCreated } from '../../lib/google-analytics-funnel'
import { useNavigate } from '../../lib/router'
import { page } from '../../styles/product-surface.stylex'
const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    maxWidth: '28rem',
  },
})

type CreateOrgResponse = {
  id: string
  slug: string
  name: string
  role: string
  redirectUrl: string
}

export function CreateOrganizationPage(): ReactNode {
  const { api, refresh, user } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const existingEmail = user?.email.trim() ?? ''
  const [email, setEmail] = useState(existingEmail)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLoading(true)
    setError(null)
    const result = await api.post<CreateOrgResponse>('/v1/organizations/self', {
      email: email.trim(),
      name: name.trim(),
      slug: slug.trim() || name.trim(),
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
    <AuthLayout>
      <form onSubmit={(event) => void handleSubmit(event)} {...stylex.props(page.root)}>
        <PageHeader
          title={<Trans>Create your organization</Trans>}
          lead={
            <Trans>
              Set up an organization to manage members, authentication, and applications.
            </Trans>
          }
        />
        <div {...stylex.props(styles.stack)}>
          <Field
            label={<Trans>Email</Trans>}
            hint={
              existingEmail ? (
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
              onChange={(event) => setName(event.target.value)}
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
              onChange={(event) => setSlug(event.target.value)}
              placeholder={name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, '-')}
              autoComplete="off"
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" disabled={loading || email.trim() === '' || name.trim() === ''}>
            {loading ? <Trans>Creating…</Trans> : <Trans>Create organization</Trans>}
          </Button>
        </div>
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
