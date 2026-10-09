// 组织投递渠道的读取与 Console 响应形状:策略缺省值、各 provider 的 secret 引用与就绪状态。

import type { schema } from '@xid-kit/db'
import type { DeliveryChannelProviderPolicy } from '@xid-kit/types'
import { normalizeDeliveryChannelsPolicy } from '@xid-kit/types'
import {
  SMS_PROVIDER_REFS,
  WHATSAPP_PROVIDER_REFS,
  deliveryChannelHasSecrets,
  smsDeliveryCredentialsReady,
  smsDeliverySecretRefs,
  whatsappDeliveryCredentialsReady,
  whatsappDeliverySecretRefs,
} from '../auth/delivery-channels'
import { readPrivateMetadata } from './org-policy-fields'

type ConsoleDeliveryChannelReadinessItem = {
  configured: boolean
  channel: string | null
}

export type ConsoleDeliveryChannelReadiness = {
  whatsappOtp: ConsoleDeliveryChannelReadinessItem
  smsOtp: ConsoleDeliveryChannelReadinessItem
}

type ConsoleDeliveryChannelProvider = {
  provider: string
  enabled: boolean
  secretRefs: string[]
  hasSecrets: boolean
  credentialsReady: boolean
}

export type ConsoleDeliveryChannels = {
  whatsapp: ConsoleDeliveryChannelProvider & {
    provider: 'twilio' | 'meta' | 'test'
    from: string
    providers: ConsoleDeliveryChannelProvider[]
  }
  sms: ConsoleDeliveryChannelProvider & {
    provider: 'twilio' | 'vonage' | 'infobip' | 'messagebird' | 'test'
    from: string
    providers: ConsoleDeliveryChannelProvider[]
  }
}

export type ResolvedDeliveryChannelsPolicy = {
  whatsapp: DeliveryChannelProviderPolicy
  sms: DeliveryChannelProviderPolicy
}

function deliveryProviderRows(
  env: Env,
  refsByProvider: Readonly<Record<string, readonly string[]>>,
  channel: 'whatsapp' | 'sms',
  selected?: DeliveryChannelProviderPolicy,
): ConsoleDeliveryChannelProvider[] {
  return Object.entries(refsByProvider).map(([provider, defaultRefs]) => {
    const enabled = selected?.provider === provider ? selected.enabled : false
    const secretRefs = selected?.provider === provider ? [...selected.secretRefs] : [...defaultRefs]
    const hasSecrets = deliveryChannelHasSecrets(env, secretRefs)
    const credentialsReady =
      selected?.provider === provider
        ? channel === 'whatsapp'
          ? whatsappDeliveryCredentialsReady(selected, env)
          : smsDeliveryCredentialsReady(selected, env)
        : false
    return {
      provider,
      enabled,
      secretRefs,
      hasSecrets,
      credentialsReady,
    }
  })
}

function defaultDeliveryChannels(): ResolvedDeliveryChannelsPolicy {
  return {
    whatsapp: {
      provider: 'meta',
      enabled: false,
      from: '',
      secretRefs: [...WHATSAPP_PROVIDER_REFS.meta],
    },
    sms: {
      provider: 'twilio',
      enabled: false,
      from: '',
      secretRefs: [...SMS_PROVIDER_REFS.twilio],
    },
  }
}

export function deliveryChannelsFromMetadata(
  metadata: Record<string, unknown>,
): ResolvedDeliveryChannelsPolicy {
  const normalized = normalizeDeliveryChannelsPolicy(metadata['deliveryChannels'])
  const defaults = defaultDeliveryChannels()
  return {
    whatsapp: { ...defaults.whatsapp, ...normalized?.whatsapp },
    sms: { ...defaults.sms, ...normalized?.sms },
  }
}

export function toConsoleDeliveryChannels(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): ConsoleDeliveryChannels {
  const policy = deliveryChannelsFromMetadata(readPrivateMetadata(org))
  const whatsappSecretRefs = whatsappDeliverySecretRefs(policy.whatsapp)
  const smsSecretRefs = smsDeliverySecretRefs(policy.sms)
  const whatsappPolicy = { ...policy.whatsapp, secretRefs: whatsappSecretRefs }
  const smsPolicy = { ...policy.sms, secretRefs: smsSecretRefs }
  return {
    whatsapp: {
      provider:
        policy.whatsapp.provider === 'twilio'
          ? 'twilio'
          : policy.whatsapp.provider === 'test'
            ? 'test'
            : 'meta',
      enabled: policy.whatsapp.enabled,
      from: policy.whatsapp.from ?? '',
      secretRefs: [...whatsappSecretRefs],
      hasSecrets: deliveryChannelHasSecrets(env, whatsappSecretRefs),
      credentialsReady: whatsappDeliveryCredentialsReady(whatsappPolicy, env),
      providers: deliveryProviderRows(env, WHATSAPP_PROVIDER_REFS, 'whatsapp', whatsappPolicy),
    },
    sms: {
      provider:
        policy.sms.provider === 'test'
          ? 'test'
          : policy.sms.provider === 'vonage' ||
              policy.sms.provider === 'infobip' ||
              policy.sms.provider === 'messagebird'
            ? policy.sms.provider
            : 'twilio',
      enabled: policy.sms.enabled,
      from: policy.sms.from ?? '',
      secretRefs: [...smsSecretRefs],
      hasSecrets: deliveryChannelHasSecrets(env, smsSecretRefs),
      credentialsReady: smsDeliveryCredentialsReady(smsPolicy, env),
      providers: deliveryProviderRows(env, SMS_PROVIDER_REFS, 'sms', smsPolicy),
    },
  }
}

export function deliveryChannelReadiness(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): ConsoleDeliveryChannelReadiness {
  const channels = toConsoleDeliveryChannels(org, env)
  return {
    whatsappOtp: {
      configured: channels.whatsapp.credentialsReady,
      channel: channels.whatsapp.credentialsReady ? channels.whatsapp.provider : null,
    },
    smsOtp: {
      configured: channels.sms.credentialsReady,
      channel: channels.sms.credentialsReady ? channels.sms.provider : null,
    },
  }
}
