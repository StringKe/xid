// SPA 入口:locale 检测 -> catalog 加载 -> Provider 链 -> RouterProvider。
// 先 await catalog 再渲染,避免首帧显示英文源文本后闪烁(浏览器 isolate 各自激活,见 i18n-lingui rule)。
// brand 用内置默认初始化;运行时拉到租户/org 品牌后由页面 setBrand 覆盖(KV brand:{tenant_id}[:{org_id}])。
// Provider 顺序:LocaleProvider(I18nProvider) -> AppMotionConfig -> QueryClientProvider -> ThemeProvider -> AuthProvider -> RouterProvider。
// Query 在 Theme/Auth 之上:auth/资源拉取走 Query,AuthProvider 之后续可改用 useQuery 管 /v1/me。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { AuthProvider } from './lib/auth-context'
import { detectLocale, type SupportedLocale } from './lib/locale'
import { activateEnglishLocale, loadInitialLocale, LocaleProvider } from './lib/locale-context'
import { AppMotionConfig } from './lib/motion'
import { queryClient } from './lib/query'
import { ThemeProvider } from './lib/theme'
import { router } from './router'
import './fonts/inter-latin.css'
import './styles.css'

function schedulePublicWebMcpBootstrap(): void {
  const run = (): void => {
    void import('./lib/webmcp/bootstrap').then(({ bootstrapPublicWebMcp }) => {
      bootstrapPublicWebMcp()
    })
  }
  if ('requestIdleCallback' in globalThis) {
    globalThis.requestIdleCallback(run, { timeout: 4_000 })
    return
  }
  globalThis.setTimeout(run, 1)
}

function mountApp(locale: SupportedLocale): void {
  document.documentElement.setAttribute('lang', locale)

  const container = document.getElementById('root')
  if (!container) throw new Error('Root element #root not found')

  createRoot(container).render(
    <StrictMode>
      <LocaleProvider initialLocale={locale}>
        <AppMotionConfig>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <AuthProvider>
                <RouterProvider router={router} />
              </AuthProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </AppMotionConfig>
      </LocaleProvider>
    </StrictMode>,
  )
}

const detectedLocale = detectLocale()
if (detectedLocale === 'en') {
  mountApp(activateEnglishLocale())
} else {
  void loadInitialLocale().then(mountApp)
}
schedulePublicWebMcpBootstrap()
