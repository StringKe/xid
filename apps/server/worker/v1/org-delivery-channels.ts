// /v1/organizations/:id/delivery-channels:组织级 WhatsApp / SMS 投递渠道配置与就绪状态。

import { createTenantDb, schema } from '@xid-kit/db'
import type { DeliveryChannelProviderPolicy } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { SMS_PROVIDER_REFS, WHATSAPP_PROVIDER_REFS } from '../auth/delivery-channels'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { deliveryFailures24h } from './org-auth-insights'
import type { DeliveryFailures24h } from './org-auth-insights'
import {
  deliveryChannelsFromMetadata,
  toConsoleDeliveryChannels,
} from './org-delivery-channel-view'
import type {
  ConsoleDeliveryChannels,
  ResolvedDeliveryChannelsPolicy,
} from './org-delivery-channel-view'
import {
  isRecord,
  readOptionalStringField,
  readPrivateMetadata,
  readStringArrayField,
  readStringField,
} from './org-policy-fields'
import { assertOrgSelfServiceEditable, isInstanceManagerUser } from './org-self-service'
import { auditOrgMutation } from './org-shared'
import {
  emitWebhookAsync,
  requireApiKeyOrOrgManager,
  requireOrg,
  type OrgScopedAuth,
} from './shared'

type ConsoleDeliveryChannelsWithStatus = ConsoleDeliveryChannels & {
  email: { fromAddress: string | null; fromName: string | null }
  failures24h: DeliveryFailures24h
}

// 字段级语义由 mergeDeliveryChannels 处理,schema 只要求 body 是对象。
const deliveryChannelsPatchBodySchema = v.record(v.string(), v.unknown())

type DeliveryChannel = 'whatsapp' | 'sms'

type ChannelRules = {
  channel: DeliveryChannel
  refsByProvider: Readonly<Record<string, readonly string[]>>
  allowedProviders: readonly string[]
}

const E164 = /^\+[1-9]\d{6,14}$/
const WHATSAPP_FROM = /^(?:whatsapp:)?\+[1-9]\d{6,14}$/
// 字母数字 sender ID 上限 11 个字符(GSM 规范),只用于 SMS。
const ALPHANUMERIC_SENDER = /^[A-Za-z0-9]{1,11}$/

function invalidField(paramName: string): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
}

function assertSenderFormat(rules: ChannelRules, provider: string, from: string | undefined): void {
  if (from === undefined || provider === 'test') return
  const valid =
    rules.channel === 'whatsapp'
      ? WHATSAPP_FROM.test(from)
      : E164.test(from) || ALPHANUMERIC_SENDER.test(from)
  if (!valid) throw invalidField(`${rules.channel}.from`)
}

function readDeliveryProviderPatch(
  raw: unknown,
  existing: DeliveryChannelProviderPolicy,
  rules: ChannelRules,
): DeliveryChannelProviderPolicy {
  if (!isRecord(raw)) return existing
  const provider = readStringField(raw, ['provider'], existing.provider).toLowerCase()
  if (!rules.allowedProviders.includes(provider)) throw invalidField(`${rules.channel}.provider`)
  const secretRefs = [...(rules.refsByProvider[provider] ?? [])]
  const requestedSecretRefs = readStringArrayField(raw, ['secretRefs', 'secret_refs'], secretRefs)
  const requestedSet = [...new Set(requestedSecretRefs)].sort()
  const expectedSet = [...secretRefs].sort()
  if (
    requestedSet.length !== expectedSet.length ||
    requestedSet.some((value, index) => value !== expectedSet[index])
  ) {
    throw invalidField('secretRefs')
  }
  const from = readOptionalStringField(raw, ['from'], existing.from)
  assertSenderFormat(rules, provider, from)
  return {
    provider,
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : existing.enabled,
    from,
    secretRefs,
  }
}

async function isMultiTenantInstance(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<boolean> {
  const rows = await drizzle(c.env.DB, { schema })
    .select({ mode: schema.instances.mode })
    .from(schema.instances)
    .where(eq(schema.instances.id, org.instanceId))
    .limit(1)
  return rows[0]?.mode === 'multi_tenant'
}

// 多租户实例共用实例级短信与 WhatsApp 凭证,组织自填发送方可冒用其他组织的号码或品牌,
// 因此只有 Instance Manager 能修改发送方。
async function assertSenderChangeAllowed(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  org: typeof schema.organizations.$inferSelect,
  change: { before: ResolvedDeliveryChannelsPolicy; after: ResolvedDeliveryChannelsPolicy },
): Promise<void> {
  const changed = (['whatsapp', 'sms'] as const).find(
    (channel) => (change.before[channel].from ?? '') !== (change.after[channel].from ?? ''),
  )
  if (!changed || !(await isMultiTenantInstance(c, org))) return
  if (auth.kind === 'org_console' && (await isInstanceManagerUser(c, auth.session.userId))) return
  throw new AppError('forbidden', { httpStatus: 403, meta: { paramName: `${changed}.from` } })
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
    whatsapp: readDeliveryProviderPatch(channels['whatsapp'], currentChannels.whatsapp, {
      channel: 'whatsapp',
      refsByProvider: WHATSAPP_PROVIDER_REFS,
      allowedProviders: ['twilio', 'meta', ...testProviders],
    }),
    sms: readDeliveryProviderPatch(channels['sms'], currentChannels.sms, {
      channel: 'sms',
      refsByProvider: SMS_PROVIDER_REFS,
      allowedProviders: ['twilio', 'vonage', 'infobip', 'messagebird', ...testProviders],
    }),
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
    const currentChannels = deliveryChannelsFromMetadata(currentMetadata)
    const deliveryChannels = mergeDeliveryChannels(currentChannels, body, c.env)
    await assertSenderChangeAllowed(c, auth, org, {
      before: currentChannels,
      after: deliveryChannels,
    })
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
