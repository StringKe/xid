# @xid-kit/angular

Angular 17+ SDK for the [XID identity platform](https://xid.dev).
Standalone components, functional guards, and an RxJS-based service on top of `@xid-kit/core`.
No NgModule required.

---

## Quick start

### 1. Register the provider (app.config.ts)

```ts
import { ApplicationConfig } from '@angular/core'
import { provideXid } from '@xid-kit/angular'

export const appConfig: ApplicationConfig = {
  providers: [
    provideXid({ apiUrl: 'https://app.xid.dev' }),
    // ...other providers
  ],
}
```

`provideXid` registers `XID_CLIENT` (the `XidClient` singleton) and wires
an `APP_INITIALIZER` that calls `client.load()` on bootstrap.

### 2. Inject XidAuthService

```ts
import { Component, inject } from '@angular/core'
import { AsyncPipe } from '@angular/common'
import { XidAuthService } from '@xid-kit/angular'

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [AsyncPipe],
  template: `
    @if (auth.isLoaded$ | async) {
      @if (auth.isSignedIn$ | async) {
        <span>{{ (auth.user$ | async)?.primaryEmailAddress }}</span>
      } @else {
        <a routerLink="/sign-in">Sign in</a>
      }
    }
  `,
})
export class HeaderComponent {
  readonly auth = inject(XidAuthService)
}
```

### 3. Use standalone components

```html
<!-- sign-in button navigates to Hosted UI -->
<xid-sign-in-button signInUrl="/sign-in" redirectUrl="/dashboard"> Log in </xid-sign-in-button>

<!-- sign-out button calls XidAuthService.signOut() -->
<xid-sign-out-button redirectUrl="/home"> Log out </xid-sign-out-button>
```

```ts
import { SignInButton, SignOutButton } from '@xid-kit/angular'

@Component({
  standalone: true,
  imports: [SignInButton, SignOutButton],
  // ...
})
export class MyComponent {}
```

### 4. Protect routes with guards

```ts
import { Routes } from '@angular/router'
import { authGuard, hasOrganizationGuard, hasPermissionGuard } from '@xid-kit/angular'

export const routes: Routes = [
  {
    path: 'dashboard',
    canActivate: [authGuard()],
    loadComponent: () => import('./dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'org-settings',
    canActivate: [hasOrganizationGuard({ redirectTo: '/select-org' })],
    loadComponent: () => import('./org-settings.component').then((m) => m.OrgSettingsComponent),
  },
  {
    path: 'admin',
    canActivate: [hasPermissionGuard('org:settings:write')],
    loadComponent: () => import('./admin.component').then((m) => m.AdminComponent),
  },
]
```

---

## API surface

### `provideXid(options?: ProvideXidOptions): EnvironmentProviders`

Registers XidClient as the `XID_CLIENT` singleton and bootstraps `load()`.

```ts
type ProvideXidOptions = {
  apiUrl?: string // Auth API root. Defaults to same-origin relative path.
  fetcher?: typeof fetch // Override fetch (for testing).
  now?: () => number // Override clock (for testing).
}
```

### `XID_CLIENT: InjectionToken<XidClient>`

The raw `XidClient` instance. Prefer `XidAuthService`; use this token only
for advanced access.

### `XidAuthService`

Injectable service (providedIn: 'root') exposing:

```ts
state$: Observable<XidState>
isLoaded$: Observable<boolean>
isSignedIn$: Observable<boolean>
user$: Observable<XidUser | null>
session$: Observable<XidSession | null>
organization$: Observable<XidOrganization | null>

getSnapshot(): XidState
getToken(options?: GetTokenOptions): Promise<Result<string, XidError>>
signOut(options?: { sessionId?: string }): Promise<Result<null, XidError>>
setActiveOrganization(organizationId: string | null): Promise<Result<XidState, XidError>>
setActiveSession(sessionId: string): Promise<Result<XidState, XidError>>
```

All Observables use `distinctUntilChanged()` so templates only re-render on real changes.

### Guards (CanActivateFn factories)

| Factory                                    | Redirects when                 |
| ------------------------------------------ | ------------------------------ |
| `authGuard(options?)`                      | user is not signed in          |
| `hasOrganizationGuard(options?)`           | no active organization context |
| `hasPermissionGuard(permission, options?)` | user lacks the permission      |

All guards accept `{ redirectTo?: string }` (defaults to `'/sign-in'`).

### `SignInButton` (standalone component)

```html
<xid-sign-in-button [signInUrl]="'/sign-in'" [redirectUrl]="'/dashboard'" ariaLabel="Log in">
  Custom label
</xid-sign-in-button>
```

Inputs: `signInUrl` (default `'/sign-in'`), `redirectUrl`, `ariaLabel`.

### `SignOutButton` (standalone component)

```html
<xid-sign-out-button [sessionId]="session.id" [redirectUrl]="'/home'">
  Log out of this session
</xid-sign-out-button>
```

Inputs: `sessionId` (omit to sign out all), `redirectUrl`, `ariaLabel`.
Shows `aria-busy` and `disabled` while the sign-out request is in flight.

---

## Peer dependencies

```
@angular/core     >=17.0.0
@angular/common   >=17.0.0
@angular/router   >=17.0.0
rxjs              >=7.0.0
```

Angular and RxJS are peer dependencies -- your app supplies them.

---

## Signals (Angular 17+)

Use Angular's `toSignal()` to bridge observables to signals in templates:

```ts
import { toSignal } from '@angular/core/rxjs-interop'
import { inject } from '@angular/core'
import { XidAuthService } from '@xid-kit/angular'

@Component({ standalone: true, ... })
export class MyComponent {
  readonly #auth = inject(XidAuthService)
  readonly user = toSignal(this.#auth.user$, { initialValue: null })
}
```

---

## How it works

`@xid-kit/angular` is a thin Angular adapter over `@xid-kit/core`:

- `XidClient` manages auth state, token refresh, and API calls.
- `XidStore` is a framework-agnostic subscribe/snapshot store.
- `XidAuthService` bridges `XidStore.subscribe` into RxJS `BehaviorSubject`.
- Guards read a single state snapshot via `service.state$.pipe(take(1))`.
- Components delegate to `XidAuthService` -- no direct client coupling.

Token storage: session tokens are `HttpOnly` cookies set by the XID Worker.
The SDK never stores tokens in `localStorage`. `getToken()` returns a short-lived
JWT (60 s default) acquired via a silent `/v1/token` request.
