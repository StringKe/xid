import { createLazyRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useSignUpContextCopy } from '../../components/hosted/context-copy'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { signUpRedirectSearch, type SignUpRedirectSearch } from './redirect'

// /sign-up 立即重定向 /sign-in?intent=sign-up;过渡态保持 AuthLayout 背景。

const styles = stylex.create({
  spinnerCenter: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBlock: '1.5rem',
  },
})

function SignUpRedirect(): ReactNode {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as SignUpRedirectSearch
  const { config } = useHostedAuthConfig()
  const context = useSignUpContextCopy(config.context)

  useEffect(() => {
    void navigate({
      to: '/sign-in' as never,
      search: signUpRedirectSearch(search) as never,
      replace: true,
    })
  }, [
    navigate,
    search.continue,
    search.redirect,
    search.locale,
    search.invitation_token,
    search.client_id,
    search.organization_id,
    search.authz_request_id,
  ])

  return (
    <AuthLayout context={context}>
      <div {...stylex.props(styles.spinnerCenter)}>
        <Spinner size={32} />
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/sign-up')({
  component: SignUpRedirect,
})
