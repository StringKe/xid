// 基于 XidAuthService 的 Angular 17+ 函数式 CanActivateFn 工厂。

import { inject } from '@angular/core'
import { Router, type CanActivateFn, type UrlTree } from '@angular/router'
import { map, take, type Observable } from 'rxjs'

import { XidAuthService } from './xid-auth.service'

type GuardOptions = {
  redirectTo?: string
}

export function authGuard(options: GuardOptions = {}): CanActivateFn {
  return (): Observable<boolean | UrlTree> => {
    const service = inject(XidAuthService)
    const router = inject(Router)
    const redirectTo = options.redirectTo ?? '/sign-in'

    return service.state$.pipe(
      take(1),
      map((state) => {
        if (state.isLoaded && state.isSignedIn && state.session !== null) {
          return true
        }
        return router.parseUrl(redirectTo)
      }),
    )
  }
}

export function hasOrganizationGuard(options: GuardOptions = {}): CanActivateFn {
  return (): Observable<boolean | UrlTree> => {
    const service = inject(XidAuthService)
    const router = inject(Router)
    const redirectTo = options.redirectTo ?? '/sign-in'

    return service.state$.pipe(
      take(1),
      map((state) => {
        if (state.isLoaded && state.isSignedIn && state.organization !== null) {
          return true
        }
        return router.parseUrl(redirectTo)
      }),
    )
  }
}

// 只查当前 active org 的 membership，禁止用 org A 权限通过 org B 路由（防 cross-org 泄漏）。
export function hasPermissionGuard(permission: string, options: GuardOptions = {}): CanActivateFn {
  return (): Observable<boolean | UrlTree> => {
    const service = inject(XidAuthService)
    const router = inject(Router)
    const redirectTo = options.redirectTo ?? '/sign-in'

    return service.state$.pipe(
      take(1),
      map((state) => {
        if (!state.isLoaded || !state.isSignedIn || state.user === null) {
          return router.parseUrl(redirectTo)
        }
        const activeMembership = state.user.organizationMemberships.find(
          (m) => m.organization.id === state.organization?.id,
        )
        const hasPerm = activeMembership?.permissions.includes(permission) === true
        return hasPerm || router.parseUrl(redirectTo)
      }),
    )
  }
}
