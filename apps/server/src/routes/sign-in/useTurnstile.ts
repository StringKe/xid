// interaction-only Turnstile;site key 缺失不回退测试 key(防生产跳过校验)。

import { useCallback, useEffect, useRef, useState } from 'react'
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
      'before-interactive-callback': () => void
      'after-interactive-callback': () => void
      action: string
      appearance: 'interaction-only'
    },
  ) => string
  remove?: (widgetId: string) => void
  reset?: (widgetId: string) => void
}

export type TurnstileHandle = {
  containerRef: (element: HTMLDivElement | null) => void
  needsInteraction: boolean
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

function turnstileApi(): TurnstileApi | undefined {
  return (globalThis as Record<string, unknown>).turnstile as TurnstileApi | undefined
}

export function normalizeTurnstileSiteKey(value: string | null | undefined): string | null {
  const sitekey = value?.trim() ?? ''
  return sitekey.length > 0 ? sitekey : null
}

// 容器随步骤换节点时把 widget 重新渲染进新节点;token 被清空时 reset,保证每次校验用新单次 token。
export function useTurnstile(
  siteKey: string | null | undefined,
  token: string | null,
  onToken: (token: string) => void,
): TurnstileHandle {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [needsInteraction, setNeedsInteraction] = useState(false)
  const widgetIdRef = useRef<string | null>(null)
  // ref 持最新回调,避免 onToken 进 deps 重复初始化 widget。
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken
  const containerRef = useCallback((element: HTMLDivElement | null) => setContainer(element), [])

  useEffect(() => {
    const normalizedSiteKey = normalizeTurnstileSiteKey(siteKey)
    if (!normalizedSiteKey || !container) return
    ensureScript()
    let timer: ReturnType<typeof setInterval> | null = null
    let disposed = false

    const settle = (value: string): void => {
      setNeedsInteraction(false)
      onTokenRef.current(value)
    }
    const mount = (): boolean => {
      if (disposed || widgetIdRef.current) return true
      const turnstile = turnstileApi()
      if (!turnstile?.render) return false
      widgetIdRef.current = turnstile.render(container, {
        sitekey: normalizedSiteKey,
        callback: settle,
        'expired-callback': () => settle(''),
        'error-callback': () => settle(''),
        'before-interactive-callback': () => setNeedsInteraction(true),
        'after-interactive-callback': () => setNeedsInteraction(false),
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
      if (widgetId) turnstileApi()?.remove?.(widgetId)
      widgetIdRef.current = null
      setNeedsInteraction(false)
    }
  }, [siteKey, container])

  useEffect(() => {
    if (token) return
    const widgetId = widgetIdRef.current
    if (!widgetId) return
    turnstileApi()?.reset?.(widgetId)
  }, [token])

  return { containerRef, needsInteraction }
}
