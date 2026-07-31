import { schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNotNull, ne, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import {
  persistCustomHostnameStateWithAudit,
  releaseCustomHostnameWithAudit,
} from '../custom-hostnames/audited-state'
import { customHostnameStatePatch } from '../custom-hostnames/state'
import {
  CloudflareCustomHostnameError,
  createCloudflareCustomHostnamesClient,
  type CloudflareCustomHostnamesClientLike,
  type CloudflareForSaasEnv,
} from '../lib/cloudflare-custom-hostnames'
import { logWorkerError } from '../lib/safe-log'

const DEFAULT_PAGE_SIZE = 100

type CustomHostnameRow = typeof schema.customHostnames.$inferSelect

export type CustomHostnameMaintenanceOptions = {
  clientFactory?: (env: Env) => CloudflareCustomHostnamesClientLike
  now?: Date
  pageSize?: number
}

function defaultClientFactory(env: Env): CloudflareCustomHostnamesClientLike {
  return createCloudflareCustomHostnamesClient(env as CloudflareForSaasEnv)
}

function isProviderNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareCustomHostnameError &&
    error.code === 'cloudflare_for_saas_http' &&
    error.status === 404
  )
}

async function expireOwnership(input: {
  env: Env
  client: CloudflareCustomHostnamesClientLike
  row: CustomHostnameRow
  remoteId: string | null
  now: Date
}): Promise<void> {
  if (input.remoteId) await input.client.delete(input.remoteId)
  await releaseCustomHostnameWithAudit(input.env, {
    row: input.row,
    action: 'custom_hostname.ownership_expired',
    now: input.now.getTime(),
  })
}

async function pollOne(
  env: Env,
  client: CloudflareCustomHostnamesClientLike,
  row: CustomHostnameRow,
  now: Date,
): Promise<void> {
  if (row.status === 'deletion_failed') {
    if (!row.cloudflareHostnameId) {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
    }
    await client.delete(row.cloudflareHostnameId)
    await persistCustomHostnameStateWithAudit(env, {
      row,
      action: 'custom_hostname.deleted',
      patch: {
        status: 'deleted',
        hostnameStatus: 'deleted',
        sslStatus: null,
        ownershipExpiresAt: null,
        deletedAt: now,
      },
      now: now.getTime(),
    })
    return
  }

  const ownershipExpired =
    row.ownershipExpiresAt !== null && row.ownershipExpiresAt.getTime() <= now.getTime()
  let remote
  try {
    remote = row.cloudflareHostnameId
      ? await client.get(row.cloudflareHostnameId)
      : await client.findByHostname(row.hostname)
  } catch (error) {
    if (!row.cloudflareHostnameId || !isProviderNotFound(error)) throw error
    if (ownershipExpired) {
      await expireOwnership({ env, client, row, remoteId: null, now })
      return
    }
    await persistCustomHostnameStateWithAudit(env, {
      row,
      action: 'custom_hostname.remote_missing',
      patch: {
        status: 'deleted',
        hostnameStatus: 'deleted',
        sslStatus: null,
        ownershipExpiresAt: null,
        deletedAt: now,
      },
      now: now.getTime(),
    })
    return
  }
  if (!remote) {
    if (ownershipExpired) {
      await expireOwnership({ env, client, row, remoteId: null, now })
    }
    return
  }
  if (
    (row.cloudflareHostnameId !== null && remote.id !== row.cloudflareHostnameId) ||
    remote.hostname !== row.hostname
  ) {
    throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
  }
  if (ownershipExpired && remote.status !== 'active') {
    await expireOwnership({ env, client, row, remoteId: remote.id, now })
    return
  }
  await persistCustomHostnameStateWithAudit(env, {
    row,
    action: 'custom_hostname.reconciled',
    patch: customHostnameStatePatch(remote, row, now),
    now: now.getTime(),
  })
}

export async function maintainCustomHostnames(
  env: Env,
  options: CustomHostnameMaintenanceOptions = {},
): Promise<void> {
  const client = (options.clientFactory ?? defaultClientFactory)(env)
  const now = options.now ?? new Date()
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE))
  const db = drizzle(env.DB, { schema })
  let cursor: string | null = null

  while (true) {
    const where = and(
      ne(schema.customHostnames.status, 'deleted'),
      or(
        isNotNull(schema.customHostnames.cloudflareHostnameId),
        eq(schema.customHostnames.status, 'provisioning_failed'),
      ),
      ...(cursor ? [gt(schema.customHostnames.id, cursor)] : []),
    )
    const rows = await db
      .select()
      .from(schema.customHostnames)
      .where(where)
      .orderBy(asc(schema.customHostnames.id))
      .limit(pageSize)
    if (rows.length === 0) return

    for (const row of rows) {
      try {
        await pollOne(env, client, row, now)
      } catch (error) {
        logWorkerError('cron.custom_hostname.poll_failed', error, {
          component: 'custom-hostname',
          operation: 'poll',
        })
      }
    }

    cursor = rows.at(-1)?.id ?? null
    if (rows.length < pageSize) return
  }
}
