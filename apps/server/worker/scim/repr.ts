// SCIM User / Group 响应体(RFC 7643)与资源版本(RFC 7644 3.14)。

import { CORE_GROUP_SCHEMA, CORE_USER_SCHEMA, ENTERPRISE_USER_SCHEMA } from './filter-parser'

export type DirectoryUserRow = {
  id: string
  tenantId: string
  directoryId: string
  userId: string | null
  externalId: string | null
  userName: string
  scimRaw: Record<string, unknown>
  active: boolean
  createdAt: Date | null
  updatedAt: Date | null
}

export type DirectoryGroupRow = {
  id: string
  tenantId: string
  directoryId: string
  displayName: string
  createdAt: Date | null
  updatedAt: Date | null
}

export type DirectoryGroupMemberRow = {
  id: string
  tenantId: string
  groupId: string
  directoryUserId: string
}

export function buildVersion(updatedAt: Date | null | undefined): string {
  const ts = updatedAt?.getTime() ?? 0
  return `W/"${ts.toString(16)}"`
}

export function versionGuardFromRow(updatedAt: Date | null | undefined): Date {
  return updatedAt ?? new Date(0)
}

function scimOrigin(baseUrl: string): string {
  return baseUrl.startsWith('http') ? new URL(baseUrl).origin : baseUrl
}

export function buildUserMeta(
  row: DirectoryUserRow,
  tenantId: string,
  baseUrl: string,
): Record<string, unknown> {
  return {
    resourceType: 'User',
    created: (row.createdAt ?? new Date()).toISOString(),
    lastModified: (row.updatedAt ?? new Date()).toISOString(),
    location: `${scimOrigin(baseUrl)}/scim/v2/organizations/${tenantId}/Users/${row.id}`,
    version: buildVersion(row.updatedAt),
  }
}

export function buildUserScimRepr(
  row: DirectoryUserRow,
  tenantId: string,
  baseUrl: string,
): Record<string, unknown> {
  const raw = row.scimRaw ?? {}
  const name = raw['name'] as Record<string, unknown> | undefined
  const emails = raw['emails'] as unknown[] | undefined
  const enterprise = raw[ENTERPRISE_USER_SCHEMA] as Record<string, unknown> | undefined
  return {
    schemas: [CORE_USER_SCHEMA],
    id: row.id,
    externalId: row.externalId ?? undefined,
    userName: row.userName,
    name: {
      givenName: name?.['givenName'] ?? undefined,
      familyName: name?.['familyName'] ?? undefined,
      formatted: name?.['formatted'] ?? undefined,
    },
    emails: emails ?? [],
    active: row.active,
    title: raw['title'] ?? undefined,
    [ENTERPRISE_USER_SCHEMA]: {
      department: enterprise?.['department'] ?? undefined,
    },
    meta: buildUserMeta(row, tenantId, baseUrl),
  }
}

export function buildGroupScimRepr(
  row: DirectoryGroupRow,
  memberRows: DirectoryGroupMemberRow[],
  tenantId: string,
  baseUrl: string,
): Record<string, unknown> {
  const base = scimOrigin(baseUrl)
  const members = memberRows.map((m) => ({
    value: m.directoryUserId,
    $ref: `${base}/scim/v2/organizations/${tenantId}/Users/${m.directoryUserId}`,
    type: 'User',
  }))
  return {
    schemas: [CORE_GROUP_SCHEMA],
    id: row.id,
    displayName: row.displayName,
    members,
    meta: {
      resourceType: 'Group',
      created: (row.createdAt ?? new Date()).toISOString(),
      lastModified: (row.updatedAt ?? new Date()).toISOString(),
      location: `${base}/scim/v2/organizations/${tenantId}/Groups/${row.id}`,
      version: buildVersion(row.updatedAt),
    },
  }
}

// 资源写响应头:Location(RFC 7644 3.3)与 ETag(3.14)
export function scimResourceHeaders(repr: Record<string, unknown>): Record<string, string> {
  const meta = repr['meta'] as { location: string; version: string }
  return { 'Content-Type': 'application/scim+json', Location: meta.location, ETag: meta.version }
}
