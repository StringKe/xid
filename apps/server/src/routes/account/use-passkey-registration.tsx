// 在账户页登记 passkey:先过 step-up,浏览器取消静默,同设备重复登记给出具体提示。
// 从根域交接到组织地址登记的,完成后经返回入口把会话交回根域的原页面。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { trackPasskeyRegistered } from '../../lib/google-analytics-funnel'
import { useDefaultPasskeyName } from '../../components/hosted/passkey-name'
import { useRegisterPasskey } from './queries'
import { useStepUpGuard } from './step-up'
import { useActionError } from './use-security-action-error'

const HANDOFF_RETURN_PARAM = 'handoff_return'
const HANDOFF_RETURN_PATH = '/auth/passkey/handoff/return'

// 浏览器取消或超时(NotAllowedError)静默;已在本设备注册过时给出具体提示。
function registrationErrorMessage(
  err: unknown,
  messages: { duplicate: string; fallback: string },
): string | null | undefined {
  if (!(err instanceof DOMException)) return undefined
  if (err.name === 'NotAllowedError' || err.name === 'AbortError') return null
  if (err.name === 'InvalidStateError') return messages.duplicate
  return messages.fallback
}

// 带返回标记时回到根域原页面(去掉标记本身);没有标记返回 false,留在当前页。
function returnToIssuerIfHandedOff(): boolean {
  const params = new URLSearchParams(window.location.search)
  if (params.get(HANDOFF_RETURN_PARAM) !== '1') return false
  params.delete(HANDOFF_RETURN_PARAM)
  const query = params.toString()
  const original = `${window.location.pathname}${query ? `?${query}` : ''}`
  window.location.assign(
    `${HANDOFF_RETURN_PATH}?${new URLSearchParams({ continue: original }).toString()}`,
  )
  return true
}

export type PasskeyRegistration = {
  register: (options: { securityKey: boolean }) => Promise<void>
  error: string | null
  isPending: boolean
  pendingSecurityKey: boolean | undefined
}

export function usePasskeyRegistration(input: {
  onStart: () => void
  onRegistered: () => void
}): PasskeyRegistration {
  const { t } = useLingui()
  const registerPasskey = useRegisterPasskey()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const defaultDeviceName = useDefaultPasskeyName()
  const [error, setError] = useState<string | null>(null)

  const register = async ({ securityKey }: { securityKey: boolean }): Promise<void> => {
    setError(null)
    input.onStart()
    try {
      await guard(
        () => registerPasskey.mutateAsync({ deviceName: defaultDeviceName, securityKey }),
        <Trans>You're about to add a passkey to your account.</Trans>,
      )
      trackPasskeyRegistered()
    } catch (err) {
      const fallback = t`The passkey wasn't created. Try again.`
      const browserMessage = registrationErrorMessage(err, {
        duplicate: t`This device already has a passkey for your account.`,
        fallback,
      })
      setError(browserMessage === undefined ? actionError(err, fallback) : browserMessage)
      return
    }
    if (returnToIssuerIfHandedOff()) return
    input.onRegistered()
  }

  return {
    register,
    error,
    isPending: registerPasskey.isPending,
    pendingSecurityKey: registerPasskey.isPending
      ? registerPasskey.variables?.securityKey === true
      : undefined,
  }
}
