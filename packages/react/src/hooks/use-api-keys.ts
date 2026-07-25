// useAPIKeys:平台级 API key 管理 hook。

import type { CreateApiKeyInput, XidApiKey, XidApiKeyWithSecret, XidPage } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseAPIKeysReturn = {
  isLoaded: boolean
  isSignedIn: boolean
  list: (input?: {
    limit?: number
    cursor?: string | null
  }) => Promise<Result<XidPage<XidApiKey>, XidError>>
  create: (input: CreateApiKeyInput) => Promise<Result<XidApiKeyWithSecret, XidError>>
  revoke: (id: string) => Promise<Result<XidApiKey, XidError>>
}

export function useAPIKeys(): UseAPIKeysReturn {
  const { client } = useXidContext()
  const state = useXidStore()
  return {
    isLoaded: state.isLoaded,
    isSignedIn: state.isSignedIn,
    list: (input = {}) => client.listApiKeys(input),
    create: (input) => client.createApiKey(input),
    revoke: (id) => client.revokeApiKey({ id }),
  }
}
