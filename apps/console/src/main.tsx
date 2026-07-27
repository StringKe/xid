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
import { SessionProvider } from '@xid-kit/web-ui/session'
import type { SessionCallbacks } from '@xid-kit/web-ui/session'
import { NavigationRuntimeProvider } from '@xid-kit/web-ui/tanstack-router'
import { ThemeProvider } from '@xid-kit/web-ui/theme'
import { setAnalyticsUserId } from './lib/google-analytics'
import { trackLogout } from './lib/google-analytics-funnel'
import { router } from './router'
import './fonts/inter-latin.css'
import './styles.css'

const CONSOLE_SESSION_CALLBACKS: SessionCallbacks = {
  onUserChange: (user) => setAnalyticsUserId(user?.id ?? null),
  onSignOut: () => trackLogout(),
}

function mountConsole(locale: SupportedLocale): void {
  document.documentElement.setAttribute('lang', locale)

  const root = document.getElementById('root')
  if (!root) throw new Error('Missing Console root element')

  createRoot(root).render(
    <StrictMode>
      <LocaleProvider initialLocale={locale}>
        <AppMotionConfig>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <SessionProvider callbacks={CONSOLE_SESSION_CALLBACKS}>
                <NavigationRuntimeProvider runtime="console">
                  <RouterProvider router={router} />
                </NavigationRuntimeProvider>
              </SessionProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </AppMotionConfig>
      </LocaleProvider>
    </StrictMode>,
  )
}

const detectedLocale = detectLocale()
if (detectedLocale === 'en') {
  mountConsole(activateEnglishLocale())
} else {
  void loadInitialLocale().then(mountConsole)
}
