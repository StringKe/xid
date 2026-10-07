// 应用详情里与协议相关的区块:Redirect URIs、Grants and tokens、Sign-out。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Alert, Button, CheckboxField, Field, Icon, Input, Textarea } from '@xid-kit/web-ui/ui'
import type { AppRecord } from './app-api'
import { SectionShell, useSave } from './app-sections'
import { sections as styles } from './section-styles'

export type RedirectProblem = 'wildcard' | 'fragment' | 'not_https'

// 与服务端 validateRedirectUris 同一套规则的前置提示:精确匹配、无通配符、无 fragment,原生应用另允许回环与自定义 scheme。
export function redirectProblem(uri: string, native: boolean): RedirectProblem | null {
  const value = uri.trim()
  if (!value) return null
  if (value.includes('*')) return 'wildcard'
  if (value.includes('#')) return 'fragment'
  if (!native && !value.startsWith('https://')) return 'not_https'
  return null
}

function RedirectProblemText({ problem }: { problem: RedirectProblem }): ReactNode {
  if (problem === 'wildcard')
    return <Trans>Wildcards are not allowed. Add each subdomain as its own URL.</Trans>
  if (problem === 'fragment') return <Trans>Remove the fragment after #.</Trans>
  return <Trans>Use an https:// URL.</Trans>
}

export function RedirectsSection({ app }: { app: AppRecord }): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { update, save } = useSave(app, t`Redirect URIs saved`)
  const [uris, setUris] = useState<string[]>(
    app.redirect_uris.length > 0 ? app.redirect_uris : [''],
  )
  const native = app.application_type === 'native'
  const problems = uris.map((uri) => redirectProblem(uri, native))
  const blocked = problems.filter(Boolean).length
  const [attempted, setAttempted] = useState(false)

  function submit(event: FormEvent): void {
    event.preventDefault()
    setAttempted(true)
    if (blocked > 0) return
    save({ redirect_uris: uris.map((uri) => uri.trim()).filter(Boolean) })
  }

  function fieldError(index: number): ReactNode {
    const problem = problems[index]
    if (problem) return <RedirectProblemText problem={problem} />
    return errorTargetsField(update.error, `redirect_uris.${index}`)
      ? errorMessage(update.error)
      : undefined
  }

  return (
    <SectionShell
      id="redirects"
      title={<Trans>Redirect URIs</Trans>}
      lead={
        <Trans>
          XID sends users back only to these exact URLs after sign-in. Each one must match character
          for character.
        </Trans>
      }
    >
      <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        {uris.map((uri, index) => (
          <div key={index} {...stylex.props(styles.uriRow)}>
            <Field label={<Trans>Redirect URI {index + 1}</Trans>} error={fieldError(index)}>
              <Input
                value={uri}
                onChange={(event) =>
                  setUris(uris.map((value, i) => (i === index ? event.currentTarget.value : value)))
                }
                spellCheck={false}
              />
            </Field>
            <button
              type="button"
              aria-label={t`Remove redirect URI ${index + 1}`}
              onClick={() => setUris(uris.filter((_value, i) => i !== index))}
              {...stylex.props(styles.remove)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setUris([...uris, ''])} {...stylex.props(styles.add)}>
          <Icon name="plus" size={14} />
          <Trans>Add redirect URI</Trans>
        </button>
        {update.error && !errorTargetsField(update.error, 'redirect_uris') ? (
          <Alert tone="error">{errorMessage(update.error)}</Alert>
        ) : null}
        <div {...stylex.props(styles.actions)}>
          <Button type="submit" isLoading={update.isPending}>
            <Trans>Save redirect URIs</Trans>
          </Button>
          {attempted && blocked > 0 ? (
            <span {...stylex.props(styles.blocked)}>
              <Trans>Not saved. Fix the highlighted URLs first.</Trans>
            </span>
          ) : null}
        </div>
      </form>
    </SectionShell>
  )
}

const GRANTS = ['authorization_code', 'refresh_token', 'client_credentials'] as const

export function GrantsSection({ app }: { app: AppRecord }): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { update, save } = useSave(app, t`Grants and tokens saved`)
  const [grants, setGrants] = useState<string[]>(app.allowed_grant_types)
  const [ttl, setTtl] = useState(
    app.access_token_ttl_sec ? String(Math.round(app.access_token_ttl_sec / 60)) : '',
  )
  const name = app.name
  const labels: Record<(typeof GRANTS)[number], { label: ReactNode; description: ReactNode }> = {
    authorization_code: {
      label: <Trans>Authorization code with PKCE</Trans>,
      description: <Trans>Users sign in through Hosted Auth. PKCE uses S256 only.</Trans>,
    },
    refresh_token: {
      label: <Trans>Refresh token</Trans>,
      description: (
        <Trans>Issued when the app asks for offline_access. Each use rotates the token.</Trans>
      ),
    },
    client_credentials: {
      label: <Trans>Client credentials</Trans>,
      description: <Trans>Lets {name} call APIs as itself, with no user present.</Trans>,
    },
  }
  const available =
    app.client_type === 'public' ? GRANTS.filter((grant) => grant !== 'client_credentials') : GRANTS

  function submit(event: FormEvent): void {
    event.preventDefault()
    const minutes = Number(ttl)
    const kept = app.allowed_grant_types.filter(
      (grant) => !(GRANTS as readonly string[]).includes(grant),
    )
    save({
      allowed_grant_types: [...new Set([...grants, ...kept])],
      access_token_ttl_sec: ttl.trim() === '' ? null : Math.round(minutes * 60),
    })
  }

  return (
    <SectionShell
      id="grants"
      title={<Trans>Grants and tokens</Trans>}
      lead={<Trans>Leave the lifetime empty to use the organization token policy.</Trans>}
    >
      <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        {available.map((grant) => (
          <CheckboxField
            key={grant}
            checked={grants.includes(grant)}
            onCheckedChange={(checked) =>
              setGrants(checked ? [...grants, grant] : grants.filter((value) => value !== grant))
            }
            label={labels[grant].label}
            description={labels[grant].description}
          />
        ))}
        <Field
          label={<Trans>Access token lifetime in minutes</Trans>}
          hint={<Trans>Between 1 and 1440 minutes.</Trans>}
          error={
            errorTargetsField(update.error, 'access_token_ttl_sec')
              ? errorMessage(update.error)
              : undefined
          }
        >
          <Input
            type="number"
            min={1}
            max={1440}
            inputMode="numeric"
            value={ttl}
            onChange={(event) => setTtl(event.currentTarget.value)}
          />
        </Field>
        {update.error && !errorTargetsField(update.error, 'access_token_ttl_sec') ? (
          <Alert tone="error">{errorMessage(update.error)}</Alert>
        ) : null}
        <div>
          <Button type="submit" isLoading={update.isPending}>
            <Trans>Save grants and tokens</Trans>
          </Button>
        </div>
      </form>
    </SectionShell>
  )
}

const SIGN_OUT_FIELDS = [
  'post_logout_redirect_uris',
  'backchannel_logout_uri',
  'frontchannel_logout_uri',
] as const

export function SignOutSection({ app }: { app: AppRecord }): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { update, save } = useSave(app, t`Sign-out settings saved`)
  const [postLogout, setPostLogout] = useState(app.post_logout_redirect_uris.join('\n'))
  const [backchannel, setBackchannel] = useState(app.backchannel_logout_uri ?? '')
  const [sessionRequired, setSessionRequired] = useState(app.backchannel_logout_session_required)
  const [frontchannel, setFrontchannel] = useState(app.frontchannel_logout_uri ?? '')
  const name = app.name
  const fieldError = (field: string) =>
    errorTargetsField(update.error, field) ? errorMessage(update.error) : undefined

  function submit(event: FormEvent): void {
    event.preventDefault()
    save({
      post_logout_redirect_uris: postLogout
        .split(/\s+/)
        .map((uri) => uri.trim())
        .filter(Boolean),
      backchannel_logout_uri: backchannel.trim() || null,
      backchannel_logout_session_required: sessionRequired,
      frontchannel_logout_uri: frontchannel.trim() || null,
    })
  }

  return (
    <SectionShell
      id="sign-out"
      title={<Trans>Sign-out</Trans>}
      lead={
        <Trans>When a user signs out of XID, XID tells {name} through the back-channel URL.</Trans>
      }
    >
      <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field
          label={<Trans>After sign-out, return to</Trans>}
          hint={<Trans>One URL per line.</Trans>}
          error={fieldError('post_logout_redirect_uris')}
        >
          <Textarea
            rows={2}
            value={postLogout}
            onChange={(event) => setPostLogout(event.currentTarget.value)}
            spellCheck={false}
          />
        </Field>
        <Field
          label={<Trans>Back-channel logout URL</Trans>}
          hint={<Trans>Must be a public HTTPS URL. XID posts a signed logout token to it.</Trans>}
          error={fieldError('backchannel_logout_uri')}
        >
          <Input
            value={backchannel}
            onChange={(event) => setBackchannel(event.currentTarget.value)}
            spellCheck={false}
          />
        </Field>
        <CheckboxField
          checked={sessionRequired}
          onCheckedChange={setSessionRequired}
          label={<Trans>Include the session ID (sid) in the logout token</Trans>}
        />
        <Field
          label={<Trans>Front-channel logout URL</Trans>}
          error={fieldError('frontchannel_logout_uri')}
        >
          <Input
            value={frontchannel}
            onChange={(event) => setFrontchannel(event.currentTarget.value)}
            spellCheck={false}
          />
        </Field>
        {update.error &&
        !SIGN_OUT_FIELDS.some((field) => errorTargetsField(update.error, field)) ? (
          <Alert tone="error">{errorMessage(update.error)}</Alert>
        ) : null}
        <div>
          <Button type="submit" isLoading={update.isPending}>
            <Trans>Save sign-out settings</Trans>
          </Button>
        </div>
      </form>
    </SectionShell>
  )
}
