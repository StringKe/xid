// /v1/organizations/:id/delivery-channels:组织级 WhatsApp / SMS 投递渠道配置与就绪状态。

import { createTenantDb, schema } from '@xid-kit/db'
import type { DeliveryChannelProviderPolicy } from '@xid-kit/types'
import { normalizeDeliveryChannelsPolicy } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import {
  SMS_PROVIDER_REFS,
  WHATSAPP_PROVIDER_REFS,
  deliveryChannelHasSecrets,
  smsDeliveryCredentialsReady,
  smsDeliverySecretRefs,
  whatsappDeliveryCredentialsReady,
  whatsappDeliverySecretRefs,
} from '../auth/delivery-channels'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { deliveryFailures24h } from './org-auth-insights'
import type { DeliveryFailures24h } from './org-auth-insights'
import {
  isRecord,
  readOptionalStringField,
  readPrivateMetadata,
  readStringArrayField,
  readStringField,
} from './org-policy-fields'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { auditOrgMutation } from './org-shared'
import { emitWebhookAsync, requireApiKeyOrOrgManager, requireOrg } from './shared'

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

type ConsoleDeliveryChannels = {
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

type ConsoleDeliveryChannelsWithStatus = ConsoleDeliveryChannels & {
  email: { fromAddress: string | null; fromName: string | null }
  failures24h: DeliveryFailures24h
}

type ResolvedDeliveryChannelsPolicy = {
  whatsapp: DeliveryChannelProviderPolicy
  sms: DeliveryChannelProviderPolicy
}

// 字段级语义由 mergeDeliveryChannels 处理,schema 只要求 body 是对象。
const deliveryChannelsPatchBodySchema = v.record(v.string(), v.unknown())

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

function deliveryChannelsFromMetadata(
  metadata: Record<string, unknown>,
): ResolvedDeliveryChannelsPolicy {
  const normalized = normalizeDeliveryChannelsPolicy(metadata['deliveryChannels'])
  const defaults = defaultDeliveryChannels()
  return {
    whatsapp: { ...defaults.whatsapp, ...normalized?.whatsapp },
    sms: { ...defaults.sms, ...normalized?.sms },
  }
}

function toConsoleDeliveryChannels(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): ConsoleDeliveryChannels {
  const policy = deliveryChannelsFromMetadata(readPrivateMetadata(org))
  const whatsappSecretRefs = whatsappDeliverySecretRefs(policy.whatsapp)
  const smsSecretRefs = smsDeliverySecretRefs(policy.sms)
  const whatsappPolicy = { ...policy.whatsapp, secretRefs: whatsappSecretRefs }
  const smsPolicy = { ...policy.sms, secretRefs: smsSecretRefs }
  const whatsappHasSecrets = deliveryChannelHasSecrets(env, whatsappSecretRefs)
  const smsHasSecrets = deliveryChannelHasSecrets(env, smsSecretRefs)
  const whatsappReady = whatsappDeliveryCredentialsReady(whatsappPolicy, env)
  const smsReady = smsDeliveryCredentialsReady(smsPolicy, env)
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
      hasSecrets: whatsappHasSecrets,
      credentialsReady: whatsappReady,
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
      hasSecrets: smsHasSecrets,
      credentialsReady: smsReady,
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

function readDeliveryProviderPatch(
  raw: unknown,
  existing: DeliveryChannelProviderPolicy,
  refsByProvider: Readonly<Record<string, readonly string[]>>,
  allowedProviders: readonly string[],
): DeliveryChannelProviderPolicy {
  if (!isRecord(raw)) return existing
  const rawProvider = readStringField(raw, ['provider'], existing.provider).toLowerCase()
  const provider = allowedProviders.includes(rawProvider) ? rawProvider : existing.provider
  const secretRefs = [...(refsByProvider[provider] ?? [])]
  const requestedSecretRefs = readStringArrayField(raw, ['secretRefs', 'secret_refs'], secretRefs)
  const requestedSet = [...new Set(requestedSecretRefs)].sort()
  const expectedSet = [...secretRefs].sort()
  if (
    requestedSet.length !== expectedSet.length ||
    requestedSet.some((value, index) => value !== expectedSet[index])
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'secretRefs' },
    })
  }
  return {
    provider,
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : existing.enabled,
    from: readOptionalStringField(raw, ['from'], existing.from),
    secretRefs,
  }
}

function mergeDeliveryChannels(
  currentChannels: ResolvedDeliveryChannelsPolicy,
  body: Record<string, unknown>,
  env: Env,
): ResolvedDeliveryChannelsPolicy {
  const rawChannels = body['deliveryChannels'] ?? body['delivery_channels'] ?? body
  const channels = isRecord(rawChannels) ? rawChannels : {}
  const testProviders = isDevOrTestEnvironment(env) ? (['test'] as const) : []
  return {
    whatsapp: readDeliveryProviderPatch(
      channels['whatsapp'],
      currentChannels.whatsapp,
      WHATSAPP_PROVIDER_REFS,
      ['twilio', 'meta', ...testProviders],
    ),
    sms: readDeliveryProviderPatch(channels['sms'], currentChannels.sms, SMS_PROVIDER_REFS, [
      'twilio',
      'vonage',
      'infobip',
      'messagebird',
      ...testProviders,
    ]),
  }
}

async function withDeliveryStatus(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<ConsoleDeliveryChannelsWithStatus> {
  return {
    ...toConsoleDeliveryChannels(org, c.env),
    email: {
      fromAddress: c.env.EMAIL_FROM_ADDRESS ?? null,
      fromName: c.env.EMAIL_FROM_NAME ?? null,
    },
    failures24h: await deliveryFailures24h(c),
  }
}

export function registerOrgDeliveryChannelRoutes(app: Hono<XidHonoEnv>): void {
  // GET /v1/organizations/:id/delivery-channels
  app.get('/:id/delivery-channels', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    const org = await requireOrg(c, id)
    return c.json(await withDeliveryStatus(c, org))
  })

  // PATCH /v1/organizations/:id/delivery-channels
  app.patch('/:id/delivery-channels', async (c) => {
    const id = c.req.param('id')
    const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
    const org = await requireOrg(c, id)
    await assertOrgSelfServiceEditable(c, auth, org)
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(deliveryChannelsPatchBodySchema, json.value)
    const currentMetadata = readPrivateMetadata(org)
    const deliveryChannels = mergeDeliveryChannels(
      deliveryChannelsFromMetadata(currentMetadata),
      body,
      c.env,
    )
    const privateMetadata = {
      ...currentMetadata,
      deliveryChannels,
    }
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const updated = await db.organizations.update(
      { privateMetadata },
      eq(schema.organizations.id, id),
    )
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.delivery_channels.updated',
      payload: { orgId: id },
    })
    auditOrgMutation(c, auth, {
      action: 'organization.delivery_channels.updated',
      orgId: id,
      targetType: 'organization',
      targetId: id,
    })
    return c.json(await withDeliveryStatus(c, updated[0]!))
  })
}
