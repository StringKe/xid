// 登录页只有一个 Turnstile widget,由当前步骤在自己的主操作上方放置挂载点。

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { TurnstileSlot } from '../../components/hosted/TurnstileSlot'
import type { TurnstileHandle } from './useTurnstile'

const SignInTurnstileContext = createContext<TurnstileHandle | null>(null)

export const SignInTurnstileProvider = SignInTurnstileContext.Provider

export function SignInTurnstileSlot(): ReactNode {
  const turnstile = useContext(SignInTurnstileContext)
  return turnstile ? <TurnstileSlot turnstile={turnstile} /> : null
}
