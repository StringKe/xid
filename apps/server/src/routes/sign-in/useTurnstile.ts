// useTurnstile:加载 Turnstile invisible widget,token 就绪时回调注入。
// invisible 模式容器 display:none,脚本异步加载不推挤任何元素(CLS 防护)。
// sitekey 缺失时不回退测试 key:禁用以防生产环境跳过人机验证(anti-abuse rule)。

import { useEffect, useRef } from 'react'

const TURNSTILE_SCRIPT_ID = 'xid-turnstile-script'

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback': () => void
      size: string
    },
  ) => string
}

type SitekeyDocument = {
  querySelector: (selector: string) => { content?: string | null } | null
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

export function readTurnstileSitekey(doc: SitekeyDocument): string | null {
  const meta = doc.querySelector('meta[name="turnstile-sitekey"]')
  const sitekey = meta?.content?.trim() ?? ''
  return sitekey.length > 0 ? sitekey : null
}

// 返回挂载容器 ref;调用方把它放到 display:none 的占位 div 上。
export function useTurnstile(onToken: (token: string) => void): {
  containerRef: React.RefObject<HTMLDivElement | null>
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  // 用 ref 持有最新回调,避免把 onToken 进依赖数组导致重复初始化 widget。
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    ensureScript()

    function mount(): boolean {
      const container = containerRef.current
      if (!container || widgetIdRef.current) return true
      const turnstile = (globalThis as Record<string, unknown>).turnstile as
        | TurnstileApi
        | undefined
      if (!turnstile?.render) return false
      const sitekey = readTurnstileSitekey(document)
      if (!sitekey) return true
      widgetIdRef.current = turnstile.render(container, {
        sitekey,
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        size: 'invisible',
      })
      return true
    }

    if (mount()) return
    // 脚本异步:轮询直到 window.turnstile 就绪。
    const timer = setInterval(() => {
      if (mount()) clearInterval(timer)
    }, 200)
    return () => clearInterval(timer)
  }, [])

  return { containerRef }
}
