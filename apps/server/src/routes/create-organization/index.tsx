import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useNavigate } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { RequireAuth } from '../../components/RequireAuth'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackOrganizationCreated } from '../../lib/google-analytics-funnel'
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

function CreateOrganizationPage(): ReactNode {
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLoading(true)
    setError(null)
    const result = await api.post<CreateOrgResponse>('/v1/organizations/self', {
      name: name.trim(),
      slug: slug.trim() || name.trim(),
    })
    setLoading(false)
    if (!result.ok) {
      setError(t`Could not create organization. Choose a different slug and try again.`)
      return
    }
    trackOrganizationCreated()
    await refresh()
    void navigate({ to: result.value.redirectUrl as never, replace: true })
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
          <Field label={<Trans>Organization name</Trans>} required>
            <Input
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
          <Button type="submit" disabled={loading || name.trim() === ''}>
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
