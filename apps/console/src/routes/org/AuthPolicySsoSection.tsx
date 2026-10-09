// Sign-in & MFA 的「Single sign-on」分节:强制企业 SSO 与密码登录总开关。
// 强制 SSO 同时写 loginPolicy.forceSso 与 hostedAuth.forceSso:生效值取两者之一,只写一处会关不掉。

import { Plural, Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { SaveButton, SettingsBlock, settingsStyles } from './AuthSettingsLayout'
import { SaveStatus, SwitchRows } from './AuthSettingsControls'
import { useSaveOrgAuthPolicy } from './auth-queries'
import type { AuthPolicyInsights, OrgAuthPolicyView, SsoConnectionView } from './auth-queries'

const styles = stylex.create({
  domainRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 48rem)': '12.5rem minmax(0, 1fr) auto',
    },
    alignItems: 'center',
    gap: '0.25rem 1rem',
    minHeight: '3.25rem',
    paddingBlock: '0.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
    lineHeight: leading.sm,
  },
  domain: {
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
    overflowWrap: 'anywhere',
  },
  connection: {
    gridColumn: { default: '1 / -1', '@media (min-width: 48rem)': 'auto' },
    gridRow: { default: 2, '@media (min-width: 48rem)': 'auto' },
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  people: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
})

export function effectiveForceSso(policy: OrgAuthPolicyView): boolean {
  return policy.loginPolicy.forceSso || policy.hostedAuth.forceSso
}

export function SingleSignOnSection({
  orgId,
  policy,
  insights,
  orgName,
  connection,
}: {
  orgId: string
  policy: OrgAuthPolicyView
  insights: AuthPolicyInsights | undefined
  orgName: ReactNode
  connection: SsoConnectionView | null
}): ReactNode {
  const enforced = effectiveForceSso(policy)
  const passwordAllowed = policy.loginPolicy.allowPasswordLogin
  const [forceSso, setForceSso] = useState(enforced)
  const [allowPassword, setAllowPassword] = useState(passwordAllowed)
  const [saved, setSaved] = useState(false)
  const mutation = useSaveOrgAuthPolicy(orgId)
  const routed = (insights?.routedDomains ?? []).filter((domain) => domain.verified)

  useEffect(() => setForceSso(enforced), [enforced])
  useEffect(() => setAllowPassword(passwordAllowed), [passwordAllowed])

  function submit(): void {
    setSaved(false)
    mutation.mutate(
      {
        loginPolicy: { forceSso, allowPasswordLogin: allowPassword },
        hostedAuth: { ...policy.hostedAuth, forceSso },
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <SettingsBlock
      id="sso"
      onSubmit={submit}
      title={<Trans>Single sign-on</Trans>}
      description={
        <Trans>
          Who in {orgName} must sign in through the enterprise connection that matches their
          verified email domain.
        </Trans>
      }
    >
      <SwitchRows
        rows={[
          {
            key: 'force-sso',
            label: <Trans>Require single sign-on</Trans>,
            description: (
              <Trans>
                Members can sign in only through enterprise SSO. Every other method stops working
                for them, including passkeys and social login. Needs an active enterprise
                connection.
              </Trans>
            ),
            checked: forceSso,
            onChange: setForceSso,
          },
          {
            key: 'password-login',
            label: <Trans>Allow password sign-in</Trans>,
            description: (
              <Trans>
                Turn off to stop everyone in this organization from signing in with a password, even
                when Password is on under Sign-in methods.
              </Trans>
            ),
            checked: allowPassword,
            onChange: setAllowPassword,
          },
        ]}
      />
      {routed.length > 0 && connection ? (
        <ul {...stylex.props(settingsStyles.rows)}>
          {routed.map((domain) => (
            <li key={domain.domain} {...stylex.props(styles.domainRow)}>
              <span {...stylex.props(styles.domain)}>{domain.domain}</span>
              <span {...stylex.props(styles.connection)}>{connection.name}</span>
              <span {...stylex.props(styles.people)}>
                <Plural value={domain.memberCount} one="# person" other="# people" />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>
            No verified domain is routed to an enterprise connection yet. Add the connection and
            verify a domain in Enterprise SSO first.
          </Trans>
        </p>
      )}
      <p {...stylex.props(settingsStyles.note)}>
        <Trans>
          Domains are routed in Enterprise SSO. Turn on Require single sign-on only after every
          active member has a routed domain, or they cannot sign in.
        </Trans>
      </p>
      <SaveButton isPending={mutation.isPending}>
        <Trans>Save single sign-on</Trans>
      </SaveButton>
      <SaveStatus error={mutation.error} saved={saved} />
    </SettingsBlock>
  )
}
