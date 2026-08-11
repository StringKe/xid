// interaction-only Turnstile;site key 缺失不回退测试 key(防生产跳过校验)。

import { useEffect, useRef } from 'react'
import { TURNSTILE_ACTION } from '../../../shared/turnstile'

const TURNSTILE_SCRIPT_ID = 'xid-turnstile-script'

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
      action: string
      appearance: 'interaction-only'
    },
  ) => string
  remove?: (widgetId: string) => void
  reset?: (widgetId: string) => void
}

function ensureScript(): void {
  if (document.getElementById(TURNSTILE_SCRIPT_ID)) return
  const script = document.createElement('script')
  script.id = TURNSTILE_SCRIPT_ID
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
  script.async = true
  script.defer = true
  document.head.appendChild(script)
}

export function normalizeTurnstileSiteKey(value: string | null | undefined): string | null {
  const sitekey = value?.trim() ?? ''
  return sitekey.length > 0 ? sitekey : null
}

// token 被清空时 reset widget,保证每次校验用新单次 token。
export function useTurnstile(
  siteKey: string | null | undefined,
  token: string | null,
  onToken: (token: string) => void,
): {
  containerRef: React.RefObject<HTMLDivElement | null>
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  // ref 持最新回调,避免 onToken 进 deps 重复初始化 widget。
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    const normalizedSiteKey = normalizeTurnstileSiteKey(siteKey)
    if (!normalizedSiteKey) return
    ensureScript()
    let timer: ReturnType<typeof setInterval> | null = null
    let disposed = false

    const mount = (): boolean => {
      if (disposed) return true
      const container = containerRef.current
      if (!container || widgetIdRef.current) return true
      const turnstile = (globalThis as Record<string, unknown>).turnstile as
        | TurnstileApi
        | undefined
      if (!turnstile?.render) return false
      widgetIdRef.current = turnstile.render(container, {
        sitekey: normalizedSiteKey,
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onTokenRef.current(''),
        action: TURNSTILE_ACTION,
        appearance: 'interaction-only',
      })
      return true
    }

    if (!mount()) {
      timer = setInterval(() => {
        if (mount() && timer) {
          clearInterval(timer)
          timer = null
        }
      }, 200)
    }
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
      const widgetId = widgetIdRef.current
      if (widgetId) {
        const turnstile = (globalThis as Record<string, unknown>).turnstile as
          | TurnstileApi
          | undefined
        turnstile?.remove?.(widgetId)
      }
      widgetIdRef.current = null
    }
  }, [siteKey])

  useEffect(() => {
    if (token) return
    const widgetId = widgetIdRef.current
    if (!widgetId) return
    const turnstile = (globalThis as Record<string, unknown>).turnstile as TurnstileApi | undefined
    turnstile?.reset?.(widgetId)
  }, [token])

  return { containerRef }
}
