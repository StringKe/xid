// MeteringDO:按 tenant 串行维护精确 MAU/DAU,避免 KV read-modify-write 竞态。
// 每个 membership 直接存 DO storage,实例不缓存用户全集,重启和大租户不放大 isolate 内存。

/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'

const MONTH_MEMBER_PREFIX = 'member:month:'
const DAY_MEMBER_PREFIX = 'member:day:'
const MONTH_COUNT_PREFIX = 'count:month:'
const DAY_COUNT_PREFIX = 'count:day:'
const EVICT_PAGE_SIZE = 1000

export type MeteringSnapshot = {
  dau: number
}

type RecordUserBody = {
  tenantId: string
  userId: string
  yearMonth: string
  day: string
}

type GetMauBody = {
  tenantId: string
  yearMonth: string
}

type MauResult = {
  tenantId: string
  yearMonth: string
  mau: number
}

type EvictMonthBody = {
  yearMonth: string
}

function monthMemberKey(yearMonth: string, userId: string): string {
  return `${MONTH_MEMBER_PREFIX}${yearMonth}:${userId}`
}

function dayMemberKey(day: string, userId: string): string {
  return `${DAY_MEMBER_PREFIX}${day}:${userId}`
}

function monthCountKey(yearMonth: string): string {
  return `${MONTH_COUNT_PREFIX}${yearMonth}`
}

function dayCountKey(day: string): string {
  return `${DAY_COUNT_PREFIX}${day}`
}

export class MeteringDO extends DurableObject<Env> {
  async recordUser(
    _tenantId: string,
    userId: string,
    yearMonth: string,
    day: string,
  ): Promise<MeteringSnapshot> {
    const monthMember = monthMemberKey(yearMonth, userId)
    const dayMember = dayMemberKey(day, userId)
    const monthCount = monthCountKey(yearMonth)
    const dayCount = dayCountKey(day)
    const [hasMonthMember, hasDayMember, storedMonthCount, storedDayCount] = await Promise.all([
      this.ctx.storage.get<boolean>(monthMember),
      this.ctx.storage.get<boolean>(dayMember),
      this.ctx.storage.get<number>(monthCount),
      this.ctx.storage.get<number>(dayCount),
    ])
    const updates: Record<string, boolean | number> = {}

    if (hasMonthMember === undefined) {
      updates[monthMember] = true
      updates[monthCount] = (storedMonthCount ?? 0) + 1
    }
    if (hasDayMember === undefined) {
      updates[dayMember] = true
      updates[dayCount] = (storedDayCount ?? 0) + 1
    }
    if (Object.keys(updates).length > 0) {
      await this.ctx.storage.put(updates)
    }

    return { dau: (updates[dayCount] as number | undefined) ?? storedDayCount ?? 0 }
  }

  async getMau(_tenantId: string, yearMonth: string): Promise<number> {
    return (await this.ctx.storage.get<number>(monthCountKey(yearMonth))) ?? 0
  }

  async evictMonth(yearMonth: string): Promise<void> {
    await this.ctx.storage.delete(monthCountKey(yearMonth))
    await Promise.all([
      this.deletePrefix(`${MONTH_MEMBER_PREFIX}${yearMonth}:`),
      this.deletePrefix(`${DAY_MEMBER_PREFIX}${yearMonth}-`),
      this.deletePrefix(`${DAY_COUNT_PREFIX}${yearMonth}-`),
    ])
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let startAfter: string | undefined
    while (true) {
      const page = await this.ctx.storage.list({
        prefix,
        limit: EVICT_PAGE_SIZE,
        ...(startAfter === undefined ? {} : { startAfter }),
      })
      const keys = Array.from(page.keys())
      if (keys.length === 0) return
      await this.ctx.storage.delete(keys)
      if (keys.length < EVICT_PAGE_SIZE) return
      startAfter = keys[keys.length - 1]
    }
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = await parseJsonBody<RecordUserBody>(request)
    if (!body) return new Response('Bad Request', { status: 400 })
    if (!body.tenantId || !body.userId || !body.yearMonth || !body.day) {
      return new Response('missing required fields', { status: 400 })
    }
    return Response.json(
      await this.recordUser(body.tenantId, body.userId, body.yearMonth, body.day),
    )
  }

  private async handleMau(request: Request): Promise<Response> {
    const body = await parseJsonBody<GetMauBody>(request)
    if (!body) return new Response('Bad Request', { status: 400 })
    if (!body.tenantId || !body.yearMonth) {
      return new Response('missing yearMonth', { status: 400 })
    }
    return Response.json({
      tenantId: body.tenantId,
      yearMonth: body.yearMonth,
      mau: await this.getMau(body.tenantId, body.yearMonth),
    } satisfies MauResult)
  }

  private async handleEvict(request: Request): Promise<Response> {
    const body = await parseJsonBody<EvictMonthBody>(request)
    if (!body) return new Response('Bad Request', { status: 400 })
    if (!body.yearMonth) return new Response('missing yearMonth', { status: 400 })
    await this.evictMonth(body.yearMonth)
    return new Response(null, { status: 204 })
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    const path = new URL(request.url).pathname
    if (path === '/record') return this.handleRecord(request)
    if (path === '/mau') return this.handleMau(request)
    if (path === '/evict') return this.handleEvict(request)
    return new Response('Not Found', { status: 404 })
  }
}

async function parseJsonBody<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T
  } catch {
    return undefined
  }
}
