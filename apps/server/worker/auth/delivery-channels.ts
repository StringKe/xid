import type {
  DeliveryChannelProviderPolicy,
  SmsProviderName,
  TenantContext,
  WhatsappProviderName,
} from '@xid-kit/types'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'

export const WHATSAPP_PROVIDER_REFS = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  meta: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
  test: [] as const,
} as const

export const SMS_PROVIDER_REFS = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  vonage: ['VONAGE_API_KEY', 'VONAGE_API_SECRET'],
  infobip: ['INFOBIP_API_KEY', 'INFOBIP_BASE_URL'],
  messagebird: ['MESSAGEBIRD_ACCESS_KEY'],
  test: [] as const,
} as const

function envHasSecret(env: Env, secretRef: string): boolean {
  return typeof (env as unknown as Record<string, unknown>)[secretRef] === 'string'
}

export function deliveryChannelHasSecrets(env: Env, refs: readonly string[]): boolean {
  return refs.length > 0 && refs.every((ref) => envHasSecret(env, ref))
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

export function whatsappDeliverySecretRefs(
  policy: DeliveryChannelProviderPolicy,
): readonly string[] {
  if (policy.provider === 'twilio') return WHATSAPP_PROVIDER_REFS.twilio
  if (policy.provider === 'meta') return WHATSAPP_PROVIDER_REFS.meta
  return WHATSAPP_PROVIDER_REFS.test
}

export function smsDeliverySecretRefs(policy: DeliveryChannelProviderPolicy): readonly string[] {
  if (
    policy.provider === 'vonage' ||
    policy.provider === 'infobip' ||
    policy.provider === 'messagebird'
  ) {
    return SMS_PROVIDER_REFS[policy.provider]
  }
  if (policy.provider === 'twilio') return SMS_PROVIDER_REFS.twilio
  return SMS_PROVIDER_REFS.test
}

function whatsappSenderReady(policy: DeliveryChannelProviderPolicy | undefined, env: Env): boolean {
  if (!policy || policy.provider === 'meta') return true
  return (
    hasValue(policy.from) ||
    hasValue(env.WHATSAPP_FROM) ||
    hasValue(env.SMS_FROM) ||
    hasValue(env.TWILIO_MESSAGING_SERVICE_SID)
  )
}

function smsSenderReady(policy: DeliveryChannelProviderPolicy | undefined, env: Env): boolean {
  if (!policy) return false
  if (policy.provider === 'twilio') {
    return (
      hasValue(policy.from) || hasValue(env.SMS_FROM) || hasValue(env.TWILIO_MESSAGING_SERVICE_SID)
    )
  }
  return hasValue(policy.from) || hasValue(env.SMS_FROM)
}

export function whatsappDeliveryCredentialsReady(
  policy: DeliveryChannelProviderPolicy | undefined,
  env: Env,
): boolean {
  if (!policy?.enabled) return false
  if (policy.provider === 'test') return isDevOrTestEnvironment(env)
  if (policy.provider === 'twilio' || policy.provider === 'meta') {
    const refs = whatsappDeliverySecretRefs(policy)
    return deliveryChannelHasSecrets(env, refs) && whatsappSenderReady(policy, env)
  }
  return false
}

export function smsDeliveryCredentialsReady(
  policy: DeliveryChannelProviderPolicy | undefined,
  env: Env,
): boolean {
  if (!policy?.enabled) return false
  if (policy.provider === 'test') return isDevOrTestEnvironment(env)
  if (
    policy.provider === 'twilio' ||
    policy.provider === 'vonage' ||
    policy.provider === 'infobip' ||
    policy.provider === 'messagebird'
  ) {
    const refs = smsDeliverySecretRefs(policy)
    return deliveryChannelHasSecrets(env, refs) && smsSenderReady(policy, env)
  }
  return false
}

export function whatsappDeliveryReady(tenant: TenantContext, env: Env): boolean {
  return whatsappDeliveryCredentialsReady(tenant.policy.deliveryChannels?.whatsapp, env)
}

export function smsDeliveryReady(tenant: TenantContext, env: Env): boolean {
  return smsDeliveryCredentialsReady(tenant.policy.deliveryChannels?.sms, env)
}

export function whatsappOtpQueuePayload(
  tenant: TenantContext,
  env: Env,
): {
  provider?: WhatsappProviderName
  from?: string
} {
  const policy = tenant.policy.deliveryChannels?.whatsapp
  if (!policy?.enabled) return {}
  if (policy.provider === 'test' && isDevOrTestEnvironment(env)) {
    return { provider: 'test', from: policy.from }
  }
  if (policy.provider !== 'twilio' && policy.provider !== 'meta') return {}
  return {
    provider: policy.provider,
    from: policy.from,
  }
}

export function smsOtpQueuePayload(
  tenant: TenantContext,
  env: Env,
): {
  provider?: SmsProviderName
  from?: string
} {
  const policy = tenant.policy.deliveryChannels?.sms
  if (!policy?.enabled) return {}
  if (policy.provider === 'test' && isDevOrTestEnvironment(env)) {
    return { provider: 'test', from: policy.from }
  }
  if (
    policy.provider !== 'twilio' &&
    policy.provider !== 'vonage' &&
    policy.provider !== 'infobip' &&
    policy.provider !== 'messagebird'
  ) {
    return {}
  }
  return {
    provider: policy.provider,
    from: policy.from,
  }
}
