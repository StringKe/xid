// Angular route guards wrapping XidAuthService (Angular 17+ functional guards).
// All guards are CanActivateFn factories that inject XidAuthService and redirect
// to /sign-in (or a custom path) when the condition is not met.
//
// Usage:
//   { path: 'dashboard', canActivate: [authGuard()] }
//   { path: 'org-settings', canActivate: [hasOrganizationGuard()] }
//   { path: 'admin', canActivate: [hasPermissionGuard('org:settings:write')] }

import { inject } from '@angular/core'
import { Router, type CanActivateFn, type UrlTree } from '@angular/router'
import { map, take, type Observable } from 'rxjs'

import { XidAuthService } from './xid-auth.service'

type GuardOptions = {
  // Route to navigate to when the guard rejects. Defaults to '/sign-in'.
  redirectTo?: string
}

// authGuard: rejects unauthenticated users and redirects to sign-in.
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

// hasOrganizationGuard: rejects users without an active organization context.
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

// hasPermissionGuard: rejects users without a specific permission in the active org membership.
// Only checks the membership for the currently active organization (state.organization),
// not any membership across all orgs -- cross-org permission leakage would let a user
// who is admin in org A pass a guard that is meant for org B.
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
