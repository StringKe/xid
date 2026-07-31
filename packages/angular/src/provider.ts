// provideXid: Angular standalone provider factory (Angular 17+, no NgModule).
// Registers XidClient as a singleton via InjectionToken, wires APP_INITIALIZER
// to call client.load() on bootstrap, and cleans up via DestroyRef on the
// application injector lifetime.
//
// Usage (app.config.ts):
//   import { provideXid } from '@xid-kit/angular'
//   export const appConfig: ApplicationConfig = {
//     providers: [provideXid({ mode: 'same-origin' })]
//   }

import {
  APP_INITIALIZER,
  DestroyRef,
  type EnvironmentProviders,
  inject,
  InjectionToken,
  makeEnvironmentProviders,
} from '@angular/core'
import { XidClient, type XidClientOptions } from '@xid-kit/core'

export type ProvideXidOptions = XidClientOptions

// XID_CLIENT: app-level injection token for the XidClient singleton.
// Prefer injecting XidAuthService; use this token only when you need raw client access.
export const XID_CLIENT = new InjectionToken<XidClient>('XidClient')

function createClientFactory(options: ProvideXidOptions): () => XidClient {
  return () => new XidClient(options)
}

function initializerFactory(): () => Promise<void> {
  const client = inject(XID_CLIENT)
  const destroyRef = inject(DestroyRef)
  const ac = new AbortController()
  destroyRef.onDestroy(() => ac.abort())
  return () => client.load({ signal: ac.signal })
}

// provideXid: registers XidClient singleton + APP_INITIALIZER bootstrap.
export function provideXid(options: ProvideXidOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: XID_CLIENT,
      useFactory: createClientFactory(options),
    },
    {
      provide: APP_INITIALIZER,
      useFactory: initializerFactory,
      deps: [],
      multi: true,
    },
  ])
}
