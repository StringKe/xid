// useSignIn:React SDK 自定义登录流底层 hook。

import type {
  SignInAnonymouslyInput,
  SignInAnonymouslyResult,
  SignInPasswordInput,
  SignInResult,
} from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseSignInReturn = {
  isLoaded: boolean
  signInPassword: (input: SignInPasswordInput) => Promise<Result<SignInResult, XidError>>
  signInAnonymously: (
    input?: SignInAnonymouslyInput,
  ) => Promise<Result<SignInAnonymouslyResult, XidError>>
}

export function useSignIn(): UseSignInReturn {
  const { client } = useXidContext()
  const state = useXidStore()
  return {
    isLoaded: state.isLoaded,
    signInPassword: (input) => client.signInPassword(input),
    signInAnonymously: (input = {}) => client.signInAnonymously(input),
  }
}
