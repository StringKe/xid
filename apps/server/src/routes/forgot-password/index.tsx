// 找回密码:request 枚举防护始终"已发送";reset token 从 URL fragment 捕获并在提交表单时消费。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import * as stylex from '@stylexjs/stylex'
import { Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { page } from '../../styles/product-surface.stylex'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'
import {
  forgotPasswordHref,
  passwordRecoverySignInHref,
  type PasswordRecoverySearch,
} from './navigation'
import { RequestDoneView, RequestStep } from './RequestStep'
import { ResetStep } from './ResetStep'

function BackToSignIn({ search }: { search: PasswordRecoverySearch }): ReactNode {
  return (
    <Link to={passwordRecoverySignInHref(search)} {...stylex.props(hosted.textLink)}>
      <Trans>Back to sign in</Trans>
    </Link>
  )
}

function ForgotPasswordPage(): ReactNode {
  const { t } = useLingui()
  // 挂两条路径,strict:false 不绑单一 route id。
  const search = useSearch({ strict: false }) as PasswordRecoverySearch & {
    token?: string
    setup?: string
  }
  const { pathname } = useLocation()
  const isResetRoute = pathname === '/reset-password'
  const { token, ready, clearToken } = useOneTimeLinkToken({
    storageKey: 'xid.password-reset.token',
    legacyQueryToken: isResetRoute ? (search.token ?? null) : null,
  })
  const backToSignIn = <BackToSignIn search={search} />
  const [requestedEmail, setRequestedEmail] = useState<string | null>(null)
  const context = {
    lead: t`Your account`,
    title: t`Password reset`,
    description: t`Reset links are single-use and expire after 15 minutes so nobody else can use an old email.`,
  }

  function content(): ReactNode {
    if (isResetRoute && !ready) {
      return (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Preparing password reset`} />
        </div>
      )
    }
    if (isResetRoute && token === null) {
      return (
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading
            title={<Trans>This reset link no longer works</Trans>}
            lead={
              <Trans>
                Reset links work once, for 15 minutes. Request a new one and open the newest email.
              </Trans>
            }
          />
          <Link to={forgotPasswordHref(search)} {...stylex.props(hosted.textLink)}>
            <Trans>Request a new reset link</Trans>
          </Link>
        </div>
      )
    }
    if (requestedEmail !== null) return <RequestDoneView email={requestedEmail} />
    if (isResetRoute) {
      return (
        <ResetStep
          token={token as string}
          clearToken={clearToken}
          isAccountSetup={String(search.setup) === '1'}
        />
      )
    }
    return <RequestStep search={search} onDone={setRequestedEmail} />
  }

  return (
    <AuthLayout context={context} footer={backToSignIn}>
      {content()}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/forgot-password')({
  component: ForgotPasswordPage,
})
