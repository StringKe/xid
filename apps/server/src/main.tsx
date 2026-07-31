// SPA 入口:locale 检测 -> catalog 加载 -> Provider 链 -> RouterProvider。
// 先 await catalog 再渲染,避免首帧显示英文源文本后闪烁(浏览器 isolate 各自激活,见 i18n-lingui rule)。
// brand 用内置默认初始化;运行时拉到租户/org 品牌后由页面 setBrand 覆盖(KV brand:{tenant_id}[:{org_id}])。
// Provider 顺序:LocaleProvider(I18nProvider) -> AppMotionConfig -> QueryClientProvider -> ThemeProvider -> AuthProvider -> RouterProvider。
// Query 在 Theme/Auth 之上:auth/资源拉取走 Query,AuthProvider 之后续可改用 useQuery 管 /v1/me。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { detectLocale, type SupportedLocale } from '@xid-kit/web-ui/locale'
import {
  LocaleProvider,
  activateEnglishLocale,
  loadInitialLocale,
} from '@xid-kit/web-ui/locale-context'
import { AppMotionConfig } from '@xid-kit/web-ui/motion'
import { queryClient } from '@xid-kit/web-ui/query'
import { NavigationRuntimeProvider } from '@xid-kit/web-ui/tanstack-router'
import { ThemeProvider } from '@xid-kit/web-ui/theme'
import { AuthProvider } from './lib/auth-context'
import { prefetchAuthConfig } from './routes/sign-in/auth-config-query'
import { router } from './router'
import './fonts/inter-latin.css'
import './styles.css'

// /sign-in 的游客入口硬依赖 /auth/config 响应:在主 chunk 即预热,使配置请求与
// locale catalog、SignInPage 懒 chunk 下载并行,而不是排在整个加载瀑布末端。
if (window.location.pathname === '/sign-in') {
  prefetchAuthConfig(queryClient, Object.fromEntries(new URLSearchParams(window.location.search)))
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
                <NavigationRuntimeProvider runtime="core">
                  <RouterProvider router={router} />
                </NavigationRuntimeProvider>
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
