// MFA 挑战:按 ?method= 与用户实际拥有的因子渲染;step-up token 含 acr:step-up(5min)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { page } from '../../styles/product-surface.stylex'
import { motion, springDefault } from '../../lib/motion'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useMfaFactorsQuery } from '../account/queries'
import { BackupCodeChallenge, SmsOtpChallenge, TotpChallenge } from './CodeChallenges'
import { CancelSignOut } from './MfaExits'
import {
  availableFactorMethods,
  isMfaMethod,
  mfaMethodSearch,
  type MfaMethod,
  type MfaSearch,
} from './mfa-search'
import { PasskeyMfaChallenge } from './PasskeyMfaChallenge'
import { styles } from './styles'

function MethodSelector({ methods }: { methods: readonly MfaMethod[] }): ReactNode {
  const { t } = useLingui()
  const search = useSearch({ strict: false }) as MfaSearch
  const labels: Record<MfaMethod, ReactNode> = {
    totp: <Trans>Authenticator app (TOTP)</Trans>,
    backup: <Trans>Backup code</Trans>,
    sms: <Trans>SMS verification</Trans>,
    passkey: <Trans>Passkey</Trans>,
  }

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Two-factor authentication</Trans>}
        lead={<Trans>Choose a verification method.</Trans>}
      />
      <nav aria-label={t`MFA methods`} {...stylex.props(styles.nav)}>
        {methods.map((method) => (
          <Link
            key={method}
            to={{ pathname: '/mfa', search: mfaMethodSearch(method, search) }}
            replace
            {...stylex.props(styles.methodLink)}
          >
            {labels[method]}
          </Link>
        ))}
      </nav>

      <CancelSignOut />
    </div>
  )
}

function MfaChallenge(props: {
  method: MfaMethod
  isStepUp: boolean
  methods: readonly MfaMethod[]
}): ReactNode {
  const { method, ...challengeProps } = props
  if (method === 'totp') return <TotpChallenge {...challengeProps} />
  if (method === 'backup') return <BackupCodeChallenge {...challengeProps} />
  if (method === 'passkey') return <PasskeyMfaChallenge {...challengeProps} />
  return <SmsOtpChallenge {...challengeProps} />
}

function MfaPage(): ReactNode {
  const { t } = useLingui()
  // strict:false:root validateSearch 透传,不绑单一 route id。
  const search = useSearch({ strict: false }) as MfaSearch
  const { data: factors, isPending, error, refetch, isRefetching } = useMfaFactorsQuery()
  const methodParam = search.method ?? null
  const isStepUp = search.step_up === '1'
  const method = isMfaMethod(methodParam) ? methodParam : null
  const methods = factors ? availableFactorMethods(factors) : []
  const selectedMethod = method && methods.includes(method) ? method : null
  const onlyMethod = methods.length === 1 ? methods[0] : null
  const activeMethod = selectedMethod ?? onlyMethod

  return (
    <AuthLayout>
      {isPending ? (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Loading verification methods.`} />
        </div>
      ) : error ? (
        <div {...stylex.props(styles.stack)}>
          <Alert tone="error">
            <Trans>Failed to load verification methods. Please try again.</Trans>
          </Alert>
          <div {...stylex.props(styles.errorActions)}>
            <Button variant="secondary" isLoading={isRefetching} onClick={() => void refetch()}>
              <Trans>Try again</Trans>
            </Button>
            <Link to="/sign-in" {...stylex.props(styles.switchLink)}>
              <Trans>Back to sign in</Trans>
            </Link>
          </div>
        </div>
      ) : activeMethod ? (
        // key=method:切换方法时重挂载以重播 enter。
        <motion.div
          key={activeMethod}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springDefault}
        >
          <MfaChallenge method={activeMethod} isStepUp={isStepUp} methods={methods} />
        </motion.div>
      ) : methods.length > 0 ? (
        <MethodSelector methods={methods} />
      ) : (
        <div {...stylex.props(styles.stack)}>
          <Alert tone="error">
            <Trans>
              No verification method is available for this account. Sign out and sign in with
              another method.
            </Trans>
          </Alert>
          <CancelSignOut />
        </div>
      )}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/mfa')({
  component: MfaPage,
})
