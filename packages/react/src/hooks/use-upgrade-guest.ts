import { useCallback, useState } from 'react'
import type { UpgradeGuestWithPasskeyInput, XidState } from '@xid-kit/core'
import { isGuestUser } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseUpgradeGuestReturn = {
  isLoaded: boolean
  // 非 guest 调用会被 client 拒绝
  isGuest: boolean
  pending: boolean
  error: XidError | null
  upgradeGuestWithPasskey: (
    input?: UpgradeGuestWithPasskeyInput,
  ) => Promise<Result<XidState, XidError>>
}

export function useUpgradeGuest(): UseUpgradeGuestReturn {
  const { client } = useXidContext()
  const state = useXidStore()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<XidError | null>(null)

  const upgradeGuestWithPasskey = useCallback(
    async (input: UpgradeGuestWithPasskeyInput = {}) => {
      setPending(true)
      setError(null)
      try {
        const result = await client.upgradeGuestWithPasskey(input)
        if (!result.ok) setError(result.error)
        return result
      } finally {
        setPending(false)
      }
    },
    [client],
  )

  return {
    isLoaded: state.isLoaded,
    isGuest: isGuestUser(state.user),
    pending,
    error,
    upgradeGuestWithPasskey,
  }
}
