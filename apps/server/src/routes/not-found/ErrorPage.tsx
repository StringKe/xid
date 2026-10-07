// 路由渲染失败时的兜底页:说明不是用户的问题,给出重试;错误细节只进控制台日志。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { Button } from '../../components/ui'

export function ErrorPage({ error }: { error: unknown }): ReactNode {
  const { t } = useLingui()
  const host = typeof window === 'undefined' ? '' : window.location.host

  useEffect(() => {
    console.error('Hosted page failed to render', error)
  }, [error])

  return (
    <AuthLayout context={{ title: t`Something went wrong`, description: t`Error on ${host}` }}>
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          title={<Trans>Something went wrong on our side</Trans>}
          lead={<Trans>This wasn't caused by anything you did. Try again in a moment.</Trans>}
        />
        <Button variant="accent" size="lg" fullWidth onClick={() => globalThis.location.reload()}>
          <Trans>Try again</Trans>
        </Button>
        <p {...stylex.props(hosted.note)}>
          <Trans>
            If it keeps happening, tell your administrator what you were doing and when.
          </Trans>
        </p>
      </div>
    </AuthLayout>
  )
}
