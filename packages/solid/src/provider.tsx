// XidProvider: SolidJS context provider. Creates XidClient, calls client.load()
// on mount via onMount, cancels on cleanup via onCleanup. Mirrors @xid-kit/react XidProvider.

import { type JSX, createMemo, onCleanup, onMount } from 'solid-js'

import { XidClient, type XidClientOptions } from '@xid-kit/core'

import { XidContext } from './context'

export type XidProviderProps = {
  readonly publishableKey: string
  readonly children: JSX.Element
  // Override API root (self-hosted; default is same-origin relative path).
  readonly apiUrl?: string
  // Inject fetch (for tests).
  readonly fetcher?: XidClientOptions['fetcher']
}

export function XidProvider(props: XidProviderProps): JSX.Element {
  // Build client once on creation. SolidJS components re-run on signal changes,
  // so we memo the options object to keep the client stable unless apiUrl changes.
  const options = createMemo<XidClientOptions>(() => ({
    ...(props.apiUrl ? { apiUrl: props.apiUrl } : {}),
    ...(props.fetcher ? { fetcher: props.fetcher } : {}),
  }))

  // Create client eagerly — it holds no heavy resource until load() is called.
  const client = new XidClient(options())

  const contextValue = createMemo(() => ({
    client,
    publishableKey: props.publishableKey,
  }))

  let abortController: AbortController | null = null

  onMount(() => {
    abortController = new AbortController()
    void client.load({ signal: abortController.signal })
  })

  onCleanup(() => {
    abortController?.abort()
  })

  return <XidContext.Provider value={contextValue()}>{props.children}</XidContext.Provider>
}
