// XidProvider: SolidJS context provider. Creates XidClient, calls client.load()
// on mount via onMount, cancels on cleanup via onCleanup. Mirrors @xid-kit/react XidProvider.

import { type JSX, onCleanup, onMount } from 'solid-js'

import {
  XidClient,
  type OidcXidClientOptions,
  type SameOriginXidClientOptions,
} from '@xid-kit/core'

import { XidContext } from './context'

export type XidProviderProps =
  | (Omit<SameOriginXidClientOptions, 'secretKey'> & { readonly children: JSX.Element })
  | (OidcXidClientOptions & { readonly children: JSX.Element })

export function XidProvider(props: XidProviderProps): JSX.Element {
  const mode: 'same-origin' | 'oidc' = props.mode === 'oidc' ? 'oidc' : 'same-origin'
  const client = new XidClient(
    props.mode === 'oidc'
      ? {
          mode: 'oidc',
          issuer: props.issuer,
          clientId: props.clientId,
          redirectUri: props.redirectUri,
          ...(props.scopes ? { scopes: props.scopes } : {}),
          ...(props.postLogoutRedirectUri
            ? { postLogoutRedirectUri: props.postLogoutRedirectUri }
            : {}),
          ...(props.tokenCache ? { tokenCache: props.tokenCache } : {}),
          ...(props.fetcher ? { fetcher: props.fetcher } : {}),
          ...(props.now ? { now: props.now } : {}),
        }
      : {
          mode: 'same-origin',
          ...(props.apiUrl ? { apiUrl: props.apiUrl } : {}),
          ...(props.fetcher ? { fetcher: props.fetcher } : {}),
          ...(props.now ? { now: props.now } : {}),
        },
  )

  let abortController: AbortController | null = null

  onMount(() => {
    abortController = new AbortController()
    void client.load({ signal: abortController.signal })
  })

  onCleanup(() => {
    abortController?.abort()
  })

  return <XidContext.Provider value={{ client, mode }}>{props.children}</XidContext.Provider>
}
