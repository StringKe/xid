import { createLazyRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { signUpRedirectSearch, type SignUpRedirectSearch } from './redirect'

// 重定向过渡态:进入 /sign-up 立即导向 /sign-in?intent=sign-up,
// 等待导航期间沿用 AuthLayout 统一背景,保持视觉连续性。

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

  useEffect(() => {
    void navigate({
      to: '/sign-in' as never,
      search: signUpRedirectSearch(search) as never,
      replace: true,
    })
  }, [navigate, search.continue, search.redirect])

  return (
    <AuthLayout>
      <div {...stylex.props(styles.spinnerCenter)}>
        <Spinner size={32} />
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/sign-up')({
  component: SignUpRedirect,
})
