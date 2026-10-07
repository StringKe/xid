// 未知路径 404,不静默重定向登录(公开 typo 不应被当成未认证)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { ACCOUNT_EXACT_PATH } from '@xid-kit/types'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { AuthLayout } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { Button } from '../../components/ui'

export default function NotFoundPage(): ReactNode {
  const { t } = useLingui()
  const navigate = useNavigate()
  const { config } = useHostedAuthConfig()
  const org = config.context.organizationName
  const host = typeof window === 'undefined' ? '' : window.location.host
  return (
    <AuthLayout
      context={{
        lead: org ?? undefined,
        title: t`Page not found`,
        description: t`Error 404 on ${host}`,
      }}
    >
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          eyebrow="404"
          title={<Trans>We can't find that page</Trans>}
          lead={
            <Trans>
              The link may be old or mistyped. If someone sent it to you, ask them for a fresh one.
            </Trans>
          }
        />
        <div {...stylex.props(hosted.group)}>
          <Button variant="accent" size="lg" fullWidth onClick={() => navigate('/sign-in')}>
            {org ? <Trans>Go to {org} sign-in</Trans> : <Trans>Go to sign-in</Trans>}
          </Button>
          <Link to={ACCOUNT_EXACT_PATH} {...stylex.props(hosted.textLink)}>
            <Trans>Go to your account</Trans>
          </Link>
        </div>
      </div>
    </AuthLayout>
  )
}
