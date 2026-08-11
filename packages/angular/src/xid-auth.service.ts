// 将 XidClient 的 subscribe/snapshot 桥接为 RxJS Observable；模板可用 async pipe 或 toSignal()。
// options.client 供单测直接注入，绕过 Angular DI（无需 TestBed）。

import { inject, Injectable, type OnDestroy } from '@angular/core'
import {
  XidClient,
  type GetTokenOptions,
  type XidOrganization,
  type XidSession,
  type XidState,
  type XidUser,
} from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'
import { BehaviorSubject, distinctUntilChanged, map, Observable } from 'rxjs'

import { XID_CLIENT } from './provider'

type XidAuthServiceOptions = {
  client?: XidClient
}

@Injectable({ providedIn: 'root' })
export class XidAuthService implements OnDestroy {
  readonly #client: XidClient
  readonly #state$: BehaviorSubject<XidState>
  readonly #unsubscribe: () => void

  constructor(options?: XidAuthServiceOptions) {
    this.#client = options?.client ?? inject(XID_CLIENT)
    this.#state$ = new BehaviorSubject<XidState>(this.#client.getSnapshot())
    this.#unsubscribe = this.#client.subscribe((state) => this.#state$.next(state))
  }

  ngOnDestroy(): void {
    this.#unsubscribe()
    this.#state$.complete()
  }

  // 完整状态流；模板绑定优先用下方派生流。
  get state$(): Observable<XidState> {
    return this.#state$.asObservable()
  }

  get isLoaded$(): Observable<boolean> {
    return this.#state$.pipe(
      map((s) => s.isLoaded),
      distinctUntilChanged(),
    )
  }

  get isSignedIn$(): Observable<boolean> {
    return this.#state$.pipe(
      map((s) => s.isSignedIn),
      distinctUntilChanged(),
    )
  }

  get user$(): Observable<XidUser | null> {
    return this.#state$.pipe(
      map((s) => s.user),
      distinctUntilChanged(),
    )
  }

  get session$(): Observable<XidSession | null> {
    return this.#state$.pipe(
      map((s) => s.session),
      distinctUntilChanged(),
    )
  }

  get organization$(): Observable<XidOrganization | null> {
    return this.#state$.pipe(
      map((s) => s.organization),
      distinctUntilChanged(),
    )
  }

  getSnapshot(): XidState {
    return this.#client.getSnapshot()
  }

  getToken(options?: GetTokenOptions): Promise<Result<string, XidError>> {
    return this.#client.getToken(options)
  }

  signOut(options?: { sessionId?: string }): Promise<Result<null, XidError>> {
    return this.#client.signOut(options)
  }

  setActiveOrganization(organizationId: string | null): Promise<Result<XidState, XidError>> {
    return this.#client.setActiveOrganization({ organizationId })
  }

  setActiveSession(sessionId: string): Promise<Result<XidState, XidError>> {
    return this.#client.setActiveSession({ sessionId })
  }
}
