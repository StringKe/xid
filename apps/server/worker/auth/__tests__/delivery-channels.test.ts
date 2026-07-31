// delivery-channels 单元测试:SMS/WhatsApp 凭证与 sender readiness、队列 payload。
import { describe, expect, it } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import {
  deliveryChannelHasSecrets,
  smsDeliveryCredentialsReady,
  smsDeliveryReady,
  smsDeliverySecretRefs,
  smsOtpQueuePayload,
  whatsappDeliveryCredentialsReady,
  whatsappDeliverySecretRefs,
  whatsappOtpQueuePayload,
} from '../delivery-channels'

function makeTenant(delivery: TenantContext['policy']['deliveryChannels']): TenantContext {
  return {
    tenantId: 'tenant_test',
    issuer: 'https://test.xid.dev',
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { deliveryChannels: delivery },
  }
}

function makeEnv(overrides: Record<string, string> = {}): Env {
  return { ENVIRONMENT: 'development', ...overrides } as unknown as Env
}

describe('deliveryChannelHasSecrets', () => {
  it('requires every configured secret ref to exist on env', () => {
    const env = makeEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' })
    expect(deliveryChannelHasSecrets(env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'])).toBe(true)
    expect(deliveryChannelHasSecrets(env, ['TWILIO_ACCOUNT_SID', 'MISSING'])).toBe(false)
    expect(deliveryChannelHasSecrets(env, [])).toBe(false)
  })
})

describe('smsDeliverySecretRefs', () => {
  it('ignores tenant-supplied refs and uses the provider binding contract', () => {
    expect(
      smsDeliverySecretRefs({
        enabled: true,
        provider: 'twilio',
        secretRefs: ['CUSTOM_KEY'],
        from: '+15550000000',
      }),
    ).toEqual(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'])
  })

  it('maps vonage provider to vonage refs', () => {
    expect(
      smsDeliverySecretRefs({ enabled: true, provider: 'vonage', secretRefs: [], from: 'XID' }),
    ).toEqual(['VONAGE_API_KEY', 'VONAGE_API_SECRET'])
  })
})

describe('smsDeliveryCredentialsReady', () => {
  it('returns false when policy disabled', () => {
    expect(
      smsDeliveryCredentialsReady(
        { enabled: false, provider: 'twilio', secretRefs: [], from: '' },
        makeEnv(),
      ),
    ).toBe(false)
  })

  it('allows test provider only in dev/test environment', () => {
    const policy = { enabled: true, provider: 'test' as const, secretRefs: [], from: 'test' }
    expect(smsDeliveryCredentialsReady(policy, makeEnv({ ENVIRONMENT: 'development' }))).toBe(true)
    expect(smsDeliveryCredentialsReady(policy, makeEnv({ ENVIRONMENT: 'production' }))).toBe(false)
  })

  it('requires twilio secrets and sender', () => {
    const policy = { enabled: true, provider: 'twilio' as const, secretRefs: [], from: '' }
    expect(
      smsDeliveryCredentialsReady(
        policy,
        makeEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', SMS_FROM: '+15550000000' }),
      ),
    ).toBe(true)
    expect(smsDeliveryCredentialsReady(policy, makeEnv({ TWILIO_ACCOUNT_SID: 'AC1' }))).toBe(false)
  })
})

describe('whatsappDeliveryCredentialsReady', () => {
  it('meta provider only needs secrets, not sender', () => {
    const policy = { enabled: true, provider: 'meta' as const, secretRefs: [], from: '' }
    expect(
      whatsappDeliveryCredentialsReady(
        policy,
        makeEnv({
          WHATSAPP_META_PHONE_NUMBER_ID: 'pn1',
          WHATSAPP_META_ACCESS_TOKEN: 'tok',
        }),
      ),
    ).toBe(true)
  })

  it('twilio whatsapp requires sender fallback from env', () => {
    const policy = { enabled: true, provider: 'twilio' as const, secretRefs: [], from: '' }
    expect(
      whatsappDeliveryCredentialsReady(
        policy,
        makeEnv({
          TWILIO_ACCOUNT_SID: 'AC1',
          TWILIO_AUTH_TOKEN: 'tok',
          TWILIO_MESSAGING_SERVICE_SID: 'MG1',
        }),
      ),
    ).toBe(true)
  })
})

describe('queue payloads', () => {
  it('smsOtpQueuePayload returns empty when disabled', () => {
    const tenant = makeTenant({
      sms: { enabled: false, provider: 'twilio', secretRefs: [], from: '' },
    })
    expect(smsOtpQueuePayload(tenant, makeEnv())).toEqual({})
  })

  it('smsOtpQueuePayload returns test provider in dev', () => {
    const tenant = makeTenant({
      sms: { enabled: true, provider: 'test', secretRefs: [], from: 'dev-sms' },
    })
    expect(smsOtpQueuePayload(tenant, makeEnv())).toEqual({ provider: 'test', from: 'dev-sms' })
  })

  it('whatsappOtpQueuePayload returns provider metadata for twilio', () => {
    const tenant = makeTenant({
      whatsapp: { enabled: true, provider: 'twilio', secretRefs: [], from: '+15550000001' },
    })
    expect(whatsappOtpQueuePayload(tenant, makeEnv())).toEqual({
      provider: 'twilio',
      from: '+15550000001',
    })
  })
})

describe('whatsappDeliverySecretRefs', () => {
  it('defaults twilio refs for twilio provider', () => {
    expect(
      whatsappDeliverySecretRefs({ enabled: true, provider: 'twilio', secretRefs: [], from: '' }),
    ).toEqual(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'])
  })
})

describe('smsDeliveryReady', () => {
  it('delegates to smsDeliveryCredentialsReady on tenant policy', () => {
    const tenant = makeTenant({
      sms: { enabled: true, provider: 'twilio', secretRefs: [], from: '+15550000000' },
    })
    const env = makeEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' })
    expect(smsDeliveryReady(tenant, env)).toBe(true)
  })
})
