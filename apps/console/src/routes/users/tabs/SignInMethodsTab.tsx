// Sign-in methods:密码、社交与企业 SSO 账号、两步验证因子、备用码、passkey。不显示任何密钥材料。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, EmptyState, Skeleton } from '@xid-kit/web-ui/ui'
import { detail } from '../../../components/page/detail-styles'
import type { UserAction, UserDetail, UserSignInMethods } from '../user-api'
import { useUserSignInMethods } from '../user-api'
import { providerName } from '../user-format'
import { formatDate } from '../../../lib/date-format'

export function useTwoStepSummary(methods: UserSignInMethods | undefined): ReactNode {
  const { t, i18n } = useLingui()
  if (!methods) return <Skeleton width="6rem" height="0.75rem" />
  const active = methods.mfaFactors.filter((factor) => factor.status === 'active')
  const labels = [
    active.some((factor) => factor.type === 'totp') ? t`Authenticator app` : null,
    active.some((factor) => factor.type === 'sms') ? t`Text message` : null,
  ].filter((label): label is string => label !== null)
  return labels.length > 0 ? (
    new Intl.ListFormat(i18n.locale, { type: 'conjunction', style: 'narrow' }).format(labels)
  ) : (
    <span {...stylex.props(detail.muted)}>{t`Off`}</span>
  )
}

function Item({
  title,
  sub,
  state,
  action,
}: {
  title: ReactNode
  sub?: ReactNode
  state: ReactNode
  action?: ReactNode
}): ReactNode {
  return (
    <li {...stylex.props(detail.itemRow)}>
      <div {...stylex.props(detail.itemMain)}>
        <span {...stylex.props(detail.itemTitle)}>{title}</span>
        {sub ? <span {...stylex.props(detail.itemSub)}>{sub}</span> : null}
      </div>
      <span {...stylex.props(detail.itemState)}>{state}</span>
      <span {...stylex.props(detail.itemAction)}>{action}</span>
    </li>
  )
}

export function SignInMethodsTab({
  user,
  name,
  onAction,
}: {
  user: UserDetail
  name: string
  onAction: (action: UserAction) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const methods = useUserSignInMethods(user.id)
  const data = methods.data
  const editable = user.status !== 'deleted'
  if (methods.isError) {
    return (
      <EmptyState
        variant="load-failure"
        title={<Trans>Sign-in methods could not be loaded</Trans>}
        action={
          <Button variant="secondary" onClick={() => void methods.refetch()}>
            <Trans>Try again</Trans>
          </Button>
        }
      />
    )
  }
  if (!data) return <Skeleton width="100%" height="8rem" />
  const factors = data.mfaFactors.filter((factor) => factor.status === 'active')
  const changed = formatDate(i18n, data.passwordUpdatedAt)
  return (
    <section {...stylex.props(detail.section)}>
      <div {...stylex.props(detail.sectionText)}>
        <h2 {...stylex.props(detail.sectionTitle)}>
          <Trans>Ways {name} can sign in</Trans>
        </h2>
        <p {...stylex.props(detail.sectionLead)}>
          <Trans>
            Email codes and magic links follow the sign-in policy of each organization and are not
            listed here.
          </Trans>
        </p>
      </div>
      <ul {...stylex.props(detail.rows)}>
        <Item
          title={<Trans>Password</Trans>}
          sub={
            data.hasPassword ? <Trans>Changed {changed}</Trans> : <Trans>No password set.</Trans>
          }
          state={data.hasPassword ? <Trans>Set</Trans> : <Trans>Not set</Trans>}
          action={
            editable && user.emails.some((row) => row.isPrimary) ? (
              <Button variant="secondary" onClick={() => onAction('password_reset')}>
                {data.hasPassword ? (
                  <Trans>Reset password…</Trans>
                ) : (
                  <Trans>Send setup link…</Trans>
                )}
              </Button>
            ) : null
          }
        />
        {data.identities.map((identity) => {
          const provider = providerName(identity.provider) ?? identity.provider ?? ''
          const linked = formatDate(i18n, identity.createdAt)
          const account = identity.providerUserId ?? ''
          return (
            <Item
              key={identity.id}
              title={
                identity.type === 'sso' ? (
                  <Trans>Enterprise SSO</Trans>
                ) : (
                  provider || <Trans>Social login</Trans>
                )
              }
              sub={
                identity.type === 'sso' ? (
                  <Trans>
                    Connection {provider}. Linked to {account} on {linked}.
                  </Trans>
                ) : (
                  <Trans>
                    Linked to {account} on {linked}.
                  </Trans>
                )
              }
              state={<Trans>Linked</Trans>}
            />
          )
        })}
        <Item
          title={<Trans>Two-step verification</Trans>}
          sub={
            factors.length > 0 ? (
              <>
                {new Intl.ListFormat(i18n.locale, { type: 'conjunction', style: 'narrow' }).format(
                  factors.map((factor) =>
                    factor.type === 'totp'
                      ? t`Authenticator app`
                      : factor.type === 'sms'
                        ? t`Text message`
                        : factor.type,
                  ),
                )}
                {data.backupCodesRemaining > 0 ? (
                  <>
                    {' · '}
                    <Plural
                      value={data.backupCodesRemaining}
                      one="# backup code left"
                      other="# backup codes left"
                    />
                  </>
                ) : null}
              </>
            ) : (
              <Trans>Not set up.</Trans>
            )
          }
          state={factors.length > 0 ? <Trans>Active</Trans> : <Trans>Off</Trans>}
          action={
            editable && factors.length > 0 ? (
              <Button variant="secondary" onClick={() => onAction('mfa_reset')}>
                <Trans>Reset MFA…</Trans>
              </Button>
            ) : null
          }
        />
        {data.passkeys.length === 0 ? (
          <Item
            title={<Trans>Passkeys</Trans>}
            sub={
              <Trans>
                None yet. {name} can create one from the Security page of their account.
              </Trans>
            }
            state={<Trans>None</Trans>}
          />
        ) : (
          data.passkeys.map((passkey) => {
            const used = formatDate(i18n, passkey.lastUsedAt)
            const added = formatDate(i18n, passkey.createdAt)
            return (
              <Item
                key={passkey.id}
                title={passkey.deviceName ?? <Trans>Passkey</Trans>}
                sub={
                  <>
                    {passkey.deviceType === 'multiDevice' ? (
                      <Trans>Synced across devices</Trans>
                    ) : (
                      <Trans>On one device or security key</Trans>
                    )}
                    {'. '}
                    {used ? <Trans>Last used {used}.</Trans> : <Trans>Added {added}.</Trans>}
                  </>
                }
                state={<Trans>Passkey</Trans>}
              />
            )
          })
        )}
      </ul>
    </section>
  )
}
