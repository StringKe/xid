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

describe('smsDeliveryCredentialsReady sender rules', () => {
  it('accepts a tenant from without SMS_FROM for vonage', () => {
    const policy = { enabled: true, provider: 'vonage' as const, secretRefs: [], from: 'Northwind' }
    expect(
      smsDeliveryCredentialsReady(
        policy,
        makeEnv({ VONAGE_API_KEY: 'key', VONAGE_API_SECRET: 'secret' }),
      ),
    ).toBe(true)
  })

  it('rejects vonage when neither the tenant nor the instance sets a from', () => {
    const policy = { enabled: true, provider: 'vonage' as const, secretRefs: [], from: '' }
    expect(
      smsDeliveryCredentialsReady(
        policy,
        makeEnv({ VONAGE_API_KEY: 'key', VONAGE_API_SECRET: 'secret' }),
      ),
    ).toBe(false)
  })

  it('requires the Bird workspace and channel but no from', () => {
    const policy = { enabled: true, provider: 'messagebird' as const, secretRefs: [], from: '' }
    expect(
      smsDeliveryCredentialsReady(
        policy,
        makeEnv({ MESSAGEBIRD_ACCESS_KEY: 'key', BIRD_WORKSPACE_ID: 'ws', BIRD_CHANNEL_ID: 'ch' }),
      ),
    ).toBe(true)
    expect(
      smsDeliveryCredentialsReady(
        policy,
        makeEnv({ MESSAGEBIRD_ACCESS_KEY: 'key', SMS_FROM: 'X' }),
      ),
    ).toBe(false)
  })
})

describe('whatsappDeliveryCredentialsReady', () => {
  const metaEnv = {
    WHATSAPP_META_PHONE_NUMBER_ID: 'pn1',
    WHATSAPP_META_ACCESS_TOKEN: 'tok',
    WHATSAPP_TEMPLATE_NAME: 'xid_otp',
    WHATSAPP_TEMPLATE_LANGUAGE: 'en_US',
  }
  const twilioEnv = {
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_WHATSAPP_CONTENT_SID: 'HX1',
  }

  it('meta provider needs credentials and the authentication template, not a sender', () => {
    const policy = { enabled: true, provider: 'meta' as const, secretRefs: [], from: '' }
    expect(whatsappDeliveryCredentialsReady(policy, makeEnv(metaEnv))).toBe(true)
  })

  it('meta provider is not ready without the template name or language', () => {
    const policy = { enabled: true, provider: 'meta' as const, secretRefs: [], from: '' }
    const { WHATSAPP_TEMPLATE_LANGUAGE: _language, ...withoutLanguage } = metaEnv
    expect(whatsappDeliveryCredentialsReady(policy, makeEnv(withoutLanguage))).toBe(false)
  })

  it('twilio whatsapp is not ready without the Content SID', () => {
    const policy = { enabled: true, provider: 'twilio' as const, secretRefs: [], from: '+1' }
    const { TWILIO_WHATSAPP_CONTENT_SID: _sid, ...withoutSid } = twilioEnv
    expect(whatsappDeliveryCredentialsReady(policy, makeEnv(withoutSid))).toBe(false)
  })

  it('twilio whatsapp accepts its own Messaging Service as the sender', () => {
    const policy = { enabled: true, provider: 'twilio' as const, secretRefs: [], from: '' }
    expect(
      whatsappDeliveryCredentialsReady(
        policy,
        makeEnv({ ...twilioEnv, TWILIO_WHATSAPP_MESSAGING_SERVICE_SID: 'MG1' }),
      ),
    ).toBe(true)
  })

  it('twilio whatsapp does not treat the SMS Messaging Service as a sender', () => {
    const policy = { enabled: true, provider: 'twilio' as const, secretRefs: [], from: '' }
    expect(
      whatsappDeliveryCredentialsReady(
        policy,
        makeEnv({ ...twilioEnv, TWILIO_MESSAGING_SERVICE_SID: 'MG1' }),
      ),
    ).toBe(false)
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
    ).toEqual(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_CONTENT_SID'])
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
