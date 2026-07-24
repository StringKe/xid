// XidAuthService: Injectable Angular service wrapping XidClient state as RxJS Observables.
// Bridges XidStore's subscribe/snapshot pattern into Angular's reactive model.
// Angular templates can use the async pipe or toSignal() on any exported observable.
//
// The optional `options.client` parameter lets unit tests supply a pre-built
// XidClient directly, bypassing Angular DI (no TestBed required).

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

  // Full state stream. Prefer the derived streams below for template bindings.
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

  // Synchronous snapshot for guards and one-shot reads.
  getSnapshot(): XidState {
    return this.#client.getSnapshot()
  }

  // Delegates to XidClient.getToken(). Returns the JWT or an error result.
  getToken(options?: GetTokenOptions): Promise<Result<string, XidError>> {
    return this.#client.getToken(options)
  }

  // Signs out the given session (or all sessions when sessionId is omitted).
  signOut(options?: { sessionId?: string }): Promise<Result<null, XidError>> {
    return this.#client.signOut(options)
  }

  // Sets the active organization context on the current session.
  setActiveOrganization(organizationId: string | null): Promise<Result<XidState, XidError>> {
    return this.#client.setActiveOrganization({ organizationId })
  }

  // Switches the active session (multi-session accounts).
  setActiveSession(sessionId: string): Promise<Result<XidState, XidError>> {
    return this.#client.setActiveSession({ sessionId })
  }
}
