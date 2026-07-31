// GET /v1/platform/feature-flags:全局 flag 配置(契约 FeatureFlag[],裸数组非分页)。
// 跨 organization 走独立管理路径(requireInstanceManager 守卫后用 KV,见 shared.ts、tenant-isolation rule)。
// flag 目录(key/label/description)是静态注册表(无 D1 flags 表);globalDefault 读 KV flag:global:{key}
//   (缺省 false);organizationOverrides 计数来自 KV per-organization override 键 flag:{tenant_id}:{key}
//   (见 cloudflare-bindings rule KV key 约定:flag:{tenant_id}:{flag_name} / flag:global:{flag_name})。

import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readJsonBody, validateBody } from '../lib/validate'
import { recordPlatformAudit } from './audit-outbox'
import { requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

const patchFeatureFlagBodySchema = v.object({
  globalDefault: v.boolean(),
})

type FeatureFlag = {
  key: string
  label: string
  description: string | null
  globalDefault: boolean
  organizationOverrides: number
}

// 静态 flag 注册表(目录真相源)。新增 flag 在此登记;globalDefault/override 仍走 KV。
const FLAG_CATALOG = [
  {
    key: 'passkey_autofill',
    label: 'Passkey autofill',
    description: 'Enable conditional UI passkey autofill on sign-in.',
  },
  {
    key: 'org_self_service',
    label: 'Org self-service',
    description: 'Allow org admins to manage SSO/MFA policies.',
  },
  {
    key: 'magic_link_login',
    label: 'Magic link login',
    description: 'Enable passwordless magic link sign-in.',
  },
  {
    key: 'social_login',
    label: 'Social login',
    description: 'Enable social identity provider sign-in.',
  },
  {
    key: 'scim_provisioning',
    label: 'SCIM provisioning',
    description: 'Enable directory sync (SCIM 2.0).',
  },
] as const

const GLOBAL_PREFIX = 'flag:global:'
const FLAG_PREFIX = 'flag:'

// 读 KV flag:global:{key},值为 '1'/'true' 视为开;缺省 false。
async function readGlobalDefault(env: Env, key: string): Promise<boolean> {
  const value = await env.CACHE.get(`${GLOBAL_PREFIX}${key}`)
  return value === '1' || value === 'true'
}

function findFlag(key: string): (typeof FLAG_CATALOG)[number] {
  const flag = FLAG_CATALOG.find((item) => item.key === key)
  if (!flag) throw new AppError('not_found', { httpStatus: 404 })
  return flag
}

// 列 KV flag:* 键,统计每个 flag 的 per-organization override 数(排除 flag:global:* 全局键)。
// key 形如 flag:{tenant_id}:{flag_name};按尾段 flag_name 归并计数(同租户同 flag 唯一键,直接计数)。
async function countOrganizationOverrides(env: Env): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  let cursor: string | undefined
  do {
    const listed = await env.CACHE.list({ prefix: FLAG_PREFIX, ...(cursor ? { cursor } : {}) })
    for (const entry of listed.keys) {
      if (entry.name.startsWith(GLOBAL_PREFIX)) continue
      const parts = entry.name.split(':')
      if (parts.length !== 3) continue
      const flagName = parts[2]
      if (!flagName) continue
      counts.set(flagName, (counts.get(flagName) ?? 0) + 1)
    }
    cursor = listed.list_complete ? undefined : listed.cursor
  } while (cursor)
  return counts
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const overrides = await countOrganizationOverrides(c.env)
  const defaults = await Promise.all(FLAG_CATALOG.map((flag) => readGlobalDefault(c.env, flag.key)))

  const data: FeatureFlag[] = FLAG_CATALOG.map((flag, i) => ({
    key: flag.key,
    label: flag.label,
    description: flag.description,
    globalDefault: defaults[i] ?? false,
    organizationOverrides: overrides.get(flag.key) ?? 0,
  }))

  return c.json(data)
})

app.patch('/:key', async (c) => {
  const session = await requireInstanceManager(c)
  const flag = findFlag(c.req.param('key'))
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchFeatureFlagBodySchema, json.value)

  await c.env.CACHE.put(`${GLOBAL_PREFIX}${flag.key}`, body.globalDefault ? '1' : '0')
  await recordPlatformAudit(c.env, {
    tenantId: 'platform',
    action: 'platform.flag_changed',
    actorId: session.userId,
    payload: {
      targetType: 'feature_flag',
      targetId: flag.key,
      globalDefault: body.globalDefault,
    },
  })
  const overrides = await countOrganizationOverrides(c.env)
  const data: FeatureFlag = {
    key: flag.key,
    label: flag.label,
    description: flag.description,
    globalDefault: body.globalDefault,
    organizationOverrides: overrides.get(flag.key) ?? 0,
  }
  return c.json(data)
})

export function registerPlatformFeatureFlagsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/feature-flags', app)
}
