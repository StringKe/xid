// 全局类型补充:Cloudflare Turnstile widget API + 运行时注入的公开配置。
// Turnstile 通过 <script> 动态注入到 window.turnstile,不随 npm 包分发。
// __XID_TURNSTILE_SITE_KEY__ 由 vite define 或 wrangler env 注入。

type TurnstileRenderOptions = {
  sitekey: string
  callback?: (token: string) => void
  'error-callback'?: () => void
  'refresh-expired'?: 'auto' | 'manual' | 'never'
  theme?: 'light' | 'dark' | 'auto'
  size?: 'normal' | 'compact' | 'invisible'
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
    __XID_TURNSTILE_SITE_KEY__?: string
  }

  // globalThis 访问:Turnstile 脚本注入 + vite define 注入的公开配置。
  // 用 var 声明使其挂到 typeof globalThis(globalThis.turnstile / globalThis.__XID_...)。
  // eslint-disable-next-line no-var
  var turnstile: TurnstileAPI | undefined
  // eslint-disable-next-line no-var
  var __XID_TURNSTILE_SITE_KEY__: string | undefined
}

export {}
