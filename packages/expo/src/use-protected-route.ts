// useProtectedRoute:Expo Router layout-level route guard hook。
// 基于 @xid-kit/react useAuth 的 isLoaded/isSignedIn 状态驱动重定向,
// 不依赖 expo-router 的类型 — 接受任何 router.replace 兼容函数以便于测试。

import { useEffect } from 'react'

import { useAuth } from '@xid-kit/react-native'

export type ProtectedRouteOptions = {
  // 未登录时重定向到的路径(如 "/sign-in")。
  signInRoute: string
  // 已登录时从 auth 屏跳转到的路径(如 "/(app)")。
  protectedRoute: string
  // 当前路径(来自 usePathname())。
  pathname: string
  // 执行重定向的函数(来自 useRouter().replace)。
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
