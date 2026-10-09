import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationProviderError } from '../notification-provider-error'
import {
  BirdSmsProvider,
  InfobipSmsProvider,
  TwilioSmsProvider,
  VonageSmsProvider,
} from '../sms-providers'

const input = { to: '+12125550142', from: '', text: 'Your code is 123456', tenantId: 'tenant-1' }

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  return init.body instanceof URLSearchParams ? init.body : JSON.parse(String(init.body))
}

async function failureOf(promise: Promise<void>): Promise<NotificationProviderError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof NotificationProviderError)) throw new Error('expected provider error')
  return error
}

const vonageEnv = { VONAGE_API_KEY: 'key', VONAGE_API_SECRET: 'secret' } as unknown as Env
const infobipEnv = {
  INFOBIP_API_KEY: 'key',
  INFOBIP_BASE_URL: 'https://example.api.infobip.com',
} as unknown as Env

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SMS sender resolution', () => {
  it('uses the tenant from when SMS_FROM is not configured', async () => {
    const fetchMock = stubFetch(Response.json({ messages: [{ status: '0' }] }))

    await new VonageSmsProvider(vonageEnv).send({ ...input, from: 'Northwind' })

    expect(requestBody(fetchMock)).toMatchObject({ from: 'Northwind' })
  })

  it('prefers the tenant from over SMS_FROM', async () => {
    const fetchMock = stubFetch(
      Response.json({ messages: [{ status: { groupId: 1, groupName: 'PENDING' } }] }),
    )
    const env = { ...infobipEnv, SMS_FROM: 'Instance' } as unknown as Env

    await new InfobipSmsProvider(env).send({ ...input, from: 'Northwind' })

    expect(requestBody(fetchMock)).toMatchObject({ messages: [{ sender: 'Northwind' }] })
  })

  it('rejects without calling the provider when neither from is configured', async () => {
    const fetchMock = stubFetch(Response.json({}))

    const failure = await failureOf(new VonageSmsProvider(vonageEnv).send(input))

    expect(failure.code).toBe('sms_from_missing')
    expect(failure.outcome).toBe('rejected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Twilio sends both From and MessagingServiceSid when the tenant sets a from', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 201 }))
    const env = {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MG1',
      SMS_FROM: '+12125550100',
    } as unknown as Env

    await new TwilioSmsProvider(env).send({ ...input, from: '+12125550199' })

    const body = requestBody(fetchMock) as URLSearchParams
    expect(body.get('From')).toBe('+12125550199')
    expect(body.get('MessagingServiceSid')).toBe('MG1')
  })

  it('Twilio leaves sender selection to the Messaging Service when the tenant has no from', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 201 }))
    const env = {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MG1',
      SMS_FROM: '+12125550100',
    } as unknown as Env

    await new TwilioSmsProvider(env).send(input)

    const body = requestBody(fetchMock) as URLSearchParams
    expect(body.has('From')).toBe(false)
    expect(body.get('MessagingServiceSid')).toBe('MG1')
  })
})

describe('Vonage response handling', () => {
  it('treats a non-zero message status as a rejection', async () => {
    stubFetch(Response.json({ messages: [{ status: '7' }] }))

    const failure = await failureOf(
      new VonageSmsProvider(vonageEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.code).toBe('vonage_status_7')
    expect(failure.outcome).toBe('rejected')
  })

  it('treats an unparseable body as an indeterminate failure', async () => {
    stubFetch(new Response('not json', { status: 200 }))

    const failure = await failureOf(
      new VonageSmsProvider(vonageEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.code).toBe('vonage_response_invalid')
    expect(failure.outcome).toBe('indeterminate')
    expect(failure.retryable).toBe(false)
  })

  it('treats an empty messages array as an indeterminate failure', async () => {
    stubFetch(Response.json({ messages: [] }))

    const failure = await failureOf(
      new VonageSmsProvider(vonageEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.code).toBe('vonage_response_invalid')
  })
})

describe('Infobip response handling', () => {
  it('treats a REJECTED status group on HTTP 200 as a rejection', async () => {
    stubFetch(Response.json({ messages: [{ status: { groupId: 5, groupName: 'REJECTED' } }] }))

    const failure = await failureOf(
      new InfobipSmsProvider(infobipEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.code).toBe('infobip_group_5')
    expect(failure.outcome).toBe('rejected')
  })

  it('treats an UNDELIVERABLE status group as a rejection', async () => {
    stubFetch(Response.json({ messages: [{ status: { groupId: 2, groupName: 'UNDELIVERABLE' } }] }))

    const failure = await failureOf(
      new InfobipSmsProvider(infobipEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.code).toBe('infobip_group_2')
  })

  it('treats a missing status as an indeterminate failure', async () => {
    stubFetch(Response.json({ messages: [{}] }))

    const failure = await failureOf(
      new InfobipSmsProvider(infobipEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.code).toBe('infobip_response_invalid')
    expect(failure.outcome).toBe('indeterminate')
  })

  it('maps HTTP 429 with Retry-After to a retryable failure', async () => {
    stubFetch(new Response('{}', { status: 429, headers: { 'retry-after': '20' } }))

    const failure = await failureOf(
      new InfobipSmsProvider(infobipEnv).send({ ...input, from: 'XID' }),
    )

    expect(failure.retryable).toBe(true)
    expect(failure.retryAfterSeconds).toBe(20)
  })
})

describe('Bird provider', () => {
  it('requires the workspace and channel ids', () => {
    const env = { MESSAGEBIRD_ACCESS_KEY: 'key' } as unknown as Env

    expect(() => new BirdSmsProvider(env)).toThrow('bird_workspace_id_missing')
  })

  it('maps an HTTP 422 to a permanent rejection', async () => {
    stubFetch(new Response('{}', { status: 422 }))
    const env = {
      MESSAGEBIRD_ACCESS_KEY: 'key',
      BIRD_WORKSPACE_ID: 'ws',
      BIRD_CHANNEL_ID: 'ch',
    } as unknown as Env

    const failure = await failureOf(new BirdSmsProvider(env).send(input))

    expect(failure.code).toBe('messagebird_422')
    expect(failure.outcome).toBe('rejected')
    expect(failure.retryable).toBe(false)
  })
})
