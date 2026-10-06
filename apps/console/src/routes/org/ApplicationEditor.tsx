import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, ConsolePageSplitSection, Field, Input, Textarea } from '@xid-kit/web-ui/ui'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { isWebRedirectUri, parseLines, parseScopes } from './application-uris'
import { useUpdateApplication } from './queries'
import type { OAuthApplication } from './types'

export function ApplicationEditor({
  application,
  onClose,
}: {
  application: OAuthApplication
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const updateApplication = useUpdateApplication()
  const [redirects, setRedirects] = useState(application.redirect_uris.join('\n'))
  const [logoutRedirects, setLogoutRedirects] = useState(
    application.post_logout_redirect_uris.join('\n'),
  )
  const [scopes, setScopes] = useState(application.allowed_scopes.join(' '))
  const [localError, setLocalError] = useState<'redirects' | 'logout' | null>(null)
  const [saved, setSaved] = useState(false)

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setSaved(false)
    const redirectUris = parseLines(redirects)
    const logoutUris = parseLines(logoutRedirects)
    if (redirectUris.length === 0 || !redirectUris.every(isWebRedirectUri)) {
      setLocalError('redirects')
      return
    }
    if (!logoutUris.every(isWebRedirectUri)) {
      setLocalError('logout')
      return
    }
    setLocalError(null)
    updateApplication.mutate(
      {
        id: application.id,
        payload: {
          redirect_uris: redirectUris,
          post_logout_redirect_uris: logoutUris,
          allowed_scopes: parseScopes(scopes),
        },
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  const serverError = updateApplication.error
  const fieldError = (field: string): string | undefined =>
    errorTargetsField(serverError, field) ? errorMessage(serverError) : undefined
  const formError =
    serverError &&
    !['redirect_uris', 'post_logout_redirect_uris', 'allowed_scopes'].some((field) =>
      errorTargetsField(serverError, field),
    )
      ? errorMessage(serverError)
      : undefined
  const invalidUriMessage = t`Enter absolute HTTPS URLs without a fragment, one per line.`

  return (
    <ConsolePageSplitSection
      title={<Trans>Edit application {application.client_id}</Trans>}
      description={
        <Trans>
          Redirect URIs are matched exactly. At least one redirect URI is required for the
          authorization code flow.
        </Trans>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <div {...stylex.props(page.gridForm)}>
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {saved ? (
            <Alert tone="success">
              <Trans>Application saved.</Trans>
            </Alert>
          ) : null}
          <Field
            label={<Trans>Redirect URIs</Trans>}
            hint={<Trans>One URI per line.</Trans>}
            error={localError === 'redirects' ? invalidUriMessage : fieldError('redirect_uris')}
            required
          >
            <Textarea value={redirects} onChange={(event) => setRedirects(event.target.value)} />
          </Field>
          <Field
            label={<Trans>Post-logout redirect URIs</Trans>}
            hint={<Trans>Optional. One URI per line.</Trans>}
            error={
              localError === 'logout' ? invalidUriMessage : fieldError('post_logout_redirect_uris')
            }
          >
            <Textarea
              value={logoutRedirects}
              onChange={(event) => setLogoutRedirects(event.target.value)}
            />
          </Field>
          <Field
            label={<Trans>Allowed scopes</Trans>}
            hint={<Trans>Separate scopes with spaces.</Trans>}
            error={fieldError('allowed_scopes')}
          >
            <Input value={scopes} onChange={(event) => setScopes(event.target.value)} />
          </Field>
          <div {...stylex.props(consoleShell.actionGroup)}>
            <Button type="submit" isLoading={updateApplication.isPending}>
              <Trans>Save changes</Trans>
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              <Trans>Close</Trans>
            </Button>
          </div>
        </div>
      </form>
    </ConsolePageSplitSection>
  )
}
