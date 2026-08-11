// provideXid：standalone 工厂，注册 XidClient 单例并在 APP_INITIALIZER 中 load，随 DestroyRef 清理。

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

// 优先注入 XidAuthService；仅在需要裸 XidClient 时使用此 token。
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
