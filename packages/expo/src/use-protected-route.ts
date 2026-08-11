// Expo Router 布局级守卫：用 useAuth 驱动重定向；replace 接受任意兼容函数以便测试。

import { useEffect } from 'react'

import { useAuth } from '@xid-kit/react-native'

export type ProtectedRouteOptions = {
  signInRoute: string
  protectedRoute: string
  pathname: string
  replace: (href: string) => void
}

export function useProtectedRoute(options: ProtectedRouteOptions): void {
  const { signInRoute, protectedRoute, pathname, replace } = options
  const { isLoaded, isSignedIn } = useAuth()

  useEffect(() => {
    if (!isLoaded) return

    const isAuthScreen = pathname.startsWith(signInRoute)

    if (!isSignedIn && !isAuthScreen) {
      replace(signInRoute)
    } else if (isSignedIn && isAuthScreen) {
      replace(protectedRoute)
    }
  }, [isLoaded, isSignedIn, pathname, signInRoute, protectedRoute, replace])
}
