// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Result } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'
import { usePasskeySignIn, type PasskeySignIn } from './usePasskeySignIn'

type HookProps = {
  identifier?: string
  identifierRequired?: boolean
  turnstileRequired?: boolean
  turnstileToken?: string | null
}

const postCalls: Array<{ path: string; body: unknown }> = []

const api: ApiClient = {
  get: async <T,>() => ({ ok: false, error: failureError() }) as Result<T>,
  post: async <T,>(path: string, body?: unknown) => {
    postCalls.push({ path, body })
    return { ok: true, value: { challenge: 'Y2hhbA', sessionId: 'handle-1' } as T }
  },
  patch: async <T,>() => ({ ok: false, error: failureError() }) as Result<T>,
  del: async <T,>() => ({ ok: false, error: failureError() }) as Result<T>,
  request: async <T,>() => ({ ok: false, error: failureError() }) as Result<T>,
}

function failureError() {
  return { code: 'server_error' as const, message: 'server_error', httpStatus: 500 }
}

const credentialsGet = vi.fn<(options: CredentialRequestOptions) => Promise<Credential | null>>()

function installWebAuthn(options: { conditional: boolean | null }): void {
  const publicKeyCredential: Record<string, unknown> = {}
  if (options.conditional !== null) {
    publicKeyCredential['isConditionalMediationAvailable'] = async () => options.conditional
  }
  Object.defineProperty(window, 'PublicKeyCredential', {
    configurable: true,
    value: publicKeyCredential,
  })
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { get: credentialsGet },
  })
}

let latest: PasskeySignIn | null = null
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null
const queryClient = new QueryClient()

function Harness(props: HookProps): null {
  latest = usePasskeySignIn({
    api,
    enabled: true,
    identifierRequired: props.identifierRequired ?? false,
    identifier: props.identifier ?? '',
    organizationId: null,
    flowFields: {},
    turnstileRequired: props.turnstileRequired ?? false,
    turnstileToken: props.turnstileToken ?? null,
    onTurnstileConsumed: () => undefined,
    onSuccess: async () => undefined,
  })
  return null
}

async function render(props: HookProps): Promise<void> {
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Harness {...props} />
      </QueryClientProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('usePasskeySignIn', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    postCalls.length = 0
    credentialsGet.mockReset()
    credentialsGet.mockImplementation(() => new Promise(() => undefined))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    latest = null
  })

  it('starts conditional mediation on a tenant host without an identifier', async () => {
    installWebAuthn({ conditional: true })

    await render({})

    expect(postCalls).toEqual([{ path: '/auth/passkey/challenge', body: {} }])
    expect(credentialsGet).toHaveBeenCalledWith(
      expect.objectContaining({ mediation: 'conditional' }),
    )
    expect(latest?.support).toBe('yes')
  })

  it('keeps the passkey tab visible while a consumed Turnstile token is replaced', async () => {
    installWebAuthn({ conditional: true })
    await render({ turnstileRequired: true, turnstileToken: 'token-1' })

    await render({ turnstileRequired: true, turnstileToken: null })
    expect(latest?.support).toBe('yes')

    await render({ turnstileRequired: true, turnstileToken: 'token-2' })
    expect(latest?.support).toBe('yes')
    expect(postCalls.filter((call) => call.path === '/auth/passkey/challenge')).toHaveLength(2)
  })

  it('offers the button flow when conditional mediation is unavailable', async () => {
    installWebAuthn({ conditional: null })
    await render({})
    expect(latest?.support).toBe('yes')
    expect(credentialsGet).not.toHaveBeenCalled()

    credentialsGet.mockResolvedValue(null)
    await act(async () => latest?.triggerButton())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(credentialsGet).toHaveBeenCalledWith(expect.objectContaining({ mediation: 'optional' }))
    expect(latest?.error).toBeNull()
  })

  it('asks for an identifier on the instance entry before requesting a challenge', async () => {
    installWebAuthn({ conditional: true })
    await render({ identifierRequired: true })
    expect(postCalls).toHaveLength(0)

    await act(async () => latest?.triggerButton())

    expect(latest?.error).toBe('identifier_required')
    expect(postCalls).toHaveLength(0)
  })
})
