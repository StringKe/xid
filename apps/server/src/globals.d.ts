// 全局类型补充:Cloudflare Turnstile widget API。
// Turnstile 通过 <script> 动态注入到 window.turnstile,不随 npm 包分发。
// Site key 从同源 /auth/config 读取,不使用 build-time global。

type TurnstileRenderOptions = {
  sitekey: string
  callback?: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: () => void
  'refresh-expired'?: 'auto' | 'manual' | 'never'
  theme?: 'light' | 'dark' | 'auto'
  size?: 'normal' | 'flexible' | 'compact'
  action?: string
  appearance?: 'always' | 'execute' | 'interaction-only'
}

type TurnstileAPI = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string
  reset: (widgetId?: string) => void
  remove: (widgetId: string) => void
  getResponse: (widgetId?: string) => string | undefined
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI
  }

  // Turnstile 脚本把 API 注入 globalThis。
  // 用 var 声明使其挂到 typeof globalThis。
  // eslint-disable-next-line no-var
  var turnstile: TurnstileAPI | undefined
}

export {}
