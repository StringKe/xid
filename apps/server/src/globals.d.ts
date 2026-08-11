// Turnstile 经 <script> 注入 window,无 npm 类型;site key 来自 /auth/config。

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

  // var 使声明挂到 typeof globalThis(脚本注入 API)。
  // eslint-disable-next-line no-var
  var turnstile: TurnstileAPI | undefined
}

export {}
