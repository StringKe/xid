// 先 await locale catalog 再渲染,避免首帧英文闪烁(isolate 各自激活)。

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

// /sign-in 游客入口依赖 /auth/config:主 chunk 预热,与 catalog 和懒 chunk 并行。
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
