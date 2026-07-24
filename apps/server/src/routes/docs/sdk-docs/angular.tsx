// @xid-kit/angular 参考页。API 真相源:packages/angular/src/index.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. Angular 17+ standalone provider, RxJS
        service, functional guards, and standalone components are implemented. A real IdP round-trip
        on production infrastructure is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Provider setup</Trans>,
    body: [
      <Trans>
        Call <code>provideXid</code> in <code>app.config.ts</code>. It registers the{' '}
        <code>XID_CLIENT</code> injection token and wires an <code>APP_INITIALIZER</code> that calls{' '}
        <code>client.load()</code> on bootstrap. No NgModule required.
      </Trans>,
    ],
    code: `// app.config.ts
import { ApplicationConfig } from '@angular/core'
import { provideXid } from '@xid-kit/angular'

export const appConfig: ApplicationConfig = {
  providers: [
    provideXid({ apiUrl: 'https://app.xid.dev' }),
  ],
}`,
  },
  {
    heading: <Trans>XidAuthService</Trans>,
    code: `import { Component, inject } from '@angular/core'
import { AsyncPipe } from '@angular/common'
import { XidAuthService } from '@xid-kit/angular'

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [AsyncPipe],
  template: \`
    @if (auth.isLoaded$ | async) {
      @if (auth.isSignedIn$ | async) {
        <span>{{ (auth.user$ | async)?.primaryEmailAddress }}</span>
      } @else {
        <a routerLink="/sign-in">Sign in</a>
      }
    }
  \`,
})
export class HeaderComponent {
  readonly auth = inject(XidAuthService)
}`,
  },
  {
    heading: <Trans>Angular signals bridge</Trans>,
    body: [
      <Trans>
        Use <code>toSignal()</code> from <code>@angular/core/rxjs-interop</code> to convert
        observables to signals for template reads.
      </Trans>,
    ],
    code: `import { toSignal } from '@angular/core/rxjs-interop'
import { inject } from '@angular/core'
import { XidAuthService } from '@xid-kit/angular'

@Component({ standalone: true, ... })
export class MyComponent {
  readonly #auth = inject(XidAuthService)
  readonly user = toSignal(this.#auth.user$, { initialValue: null })
}`,
  },
  {
    heading: <Trans>Route guards</Trans>,
    code: `import { Routes } from '@angular/router'
import { authGuard, hasOrganizationGuard, hasPermissionGuard } from '@xid-kit/angular'

export const routes: Routes = [
  {
    path: 'dashboard',
    canActivate: [authGuard()],
    loadComponent: () => import('./dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'admin',
    canActivate: [hasPermissionGuard('org:settings:write')],
    loadComponent: () => import('./admin.component').then(m => m.AdminComponent),
  },
]`,
  },
  {
    heading: <Trans>Standalone components</Trans>,
    code: `<!-- template -->
<xid-sign-in-button signInUrl="/sign-in" redirectUrl="/dashboard">Log in</xid-sign-in-button>
<xid-sign-out-button redirectUrl="/home">Log out</xid-sign-out-button>`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">provideXid</code>,
          <Trans>function</Trans>,
          <Trans>
            Registers XID_CLIENT singleton and APP_INITIALIZER; accepts ProvideXidOptions
          </Trans>,
        ],
        [
          <code key="e">XID_CLIENT</code>,
          <Trans>InjectionToken</Trans>,
          <Trans>The raw XidClient instance; prefer XidAuthService for most use cases</Trans>,
        ],
        [
          <code key="e">XidAuthService</code>,
          <Trans>service</Trans>,
          <Trans>
            RxJS observables: state$, isLoaded$, isSignedIn$, user$, session$, organization$; plus
            getToken, signOut, setActiveOrganization, setActiveSession
          </Trans>,
        ],
        [
          <code key="e">authGuard</code>,
          <Trans>CanActivateFn factory</Trans>,
          <Trans>Redirects to /sign-in when user is not signed in</Trans>,
        ],
        [
          <code key="e">hasOrganizationGuard</code>,
          <Trans>CanActivateFn factory</Trans>,
          <Trans>Redirects when no active organization context is present</Trans>,
        ],
        [
          <code key="e">hasPermissionGuard</code>,
          <Trans>CanActivateFn factory</Trans>,
          <Trans>Redirects when user lacks the specified permission</Trans>,
        ],
        [
          <code key="e">SignInButton</code>,
          <Trans>standalone component</Trans>,
          <Trans>Selector xid-sign-in-button; inputs signInUrl, redirectUrl, ariaLabel</Trans>,
        ],
        [
          <code key="e">SignOutButton</code>,
          <Trans>standalone component</Trans>,
          <Trans>
            Selector xid-sign-out-button; inputs sessionId, redirectUrl, ariaLabel; shows aria-busy
            while signing out
          </Trans>,
        ],
      ],
    },
  },
]

export const ANGULAR_DOC = defineSdkDoc({
  slug: 'sdks/angular',
  packageName: '@xid-kit/angular',
  summary: (
    <Trans>
      Angular 17+ standalone provider, RxJS service, functional route guards, and standalone
      components on top of @xid-kit/core.
    </Trans>
  ),
  sections,
})
