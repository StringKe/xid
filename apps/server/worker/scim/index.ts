// SCIM 2.0 server 路由注册入口
// 端点前缀:/scim/v2/organizations/{organization_id}/(见 04 章 5 / 9)
// 含 Users / Groups / ServiceProviderConfig / Schemas / ResourceTypes
// organization_id 来自路径参数,不信任请求 body(见 tenant-isolation rule)

import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { registerScimUsersRoutes } from './users'
import { registerScimGroupsRoutes } from './groups'
import { registerScimBulkRoutes } from './bulk'
import { registerOutboundScimRoutes } from './outbound'
import { SCIM_BULK_MAX_OPERATIONS, SCIM_BULK_MAX_PAYLOAD_SIZE } from './shared'

const SCIM_BASE = '/scim/v2/organizations/:organization_id'

// ServiceProviderConfig -- 告知 SCIM client 支持的功能
const SERVICE_PROVIDER_CONFIG = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://xid.dev/scim',
  patch: { supported: true },
  bulk: {
    supported: true,
    maxOperations: SCIM_BULK_MAX_OPERATIONS,
    maxPayloadSize: SCIM_BULK_MAX_PAYLOAD_SIZE,
  },
  filter: { supported: true, maxResults: 100 },
  changePassword: { supported: false },
  sort: { supported: true },
  etag: { supported: true },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Authentication scheme using the OAuth Bearer Token standard',
      specUri: 'http://www.rfc-editor.org/info/rfc6750',
      primary: true,
    },
  ],
  meta: {
    resourceType: 'ServiceProviderConfig',
    location: '/scim/v2/ServiceProviderConfig',
  },
}

// Schemas endpoint -- 返回支持的 SCIM 资源 schema
const SCIM_SCHEMAS = [
  {
    id: 'urn:ietf:params:scim:schemas:core:2.0:User',
    name: 'User',
    description: 'User Account',
    attributes: [
      { name: 'userName', type: 'string', required: true, caseExact: false },
      { name: 'name', type: 'complex' },
      { name: 'emails', type: 'complex', multiValued: true },
      { name: 'active', type: 'boolean' },
      { name: 'externalId', type: 'string' },
      { name: 'title', type: 'string' },
    ],
    meta: {
      resourceType: 'Schema',
      location: '/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User',
    },
  },
  {
    id: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    name: 'EnterpriseUser',
    description: 'Enterprise User',
    attributes: [
      { name: 'employeeNumber', type: 'string' },
      { name: 'costCenter', type: 'string' },
      { name: 'organization', type: 'string' },
      { name: 'division', type: 'string' },
      { name: 'department', type: 'string' },
      {
        name: 'manager',
        type: 'complex',
        subAttributes: [
          { name: 'value', type: 'string' },
          { name: '$ref', type: 'reference', referenceTypes: ['User'] },
          { name: 'displayName', type: 'string' },
        ],
      },
    ],
    meta: {
      resourceType: 'Schema',
      location: '/scim/v2/Schemas/urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    },
  },
  {
    id: 'urn:ietf:params:scim:schemas:core:2.0:Group',
    name: 'Group',
    description: 'Group',
    attributes: [
      { name: 'displayName', type: 'string', required: true, caseExact: false },
      { name: 'members', type: 'complex', multiValued: true },
    ],
    meta: {
      resourceType: 'Schema',
      location: '/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group',
    },
  },
]

// ResourceTypes endpoint
const SCIM_RESOURCE_TYPES = [
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
    schemaExtensions: [
      {
        schema: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
        required: false,
      },
    ],
    meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
  },
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'Group',
    name: 'Group',
    endpoint: '/Groups',
    schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
    meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' },
  },
]

export function registerScimRoutes(app: Hono<XidHonoEnv>): void {
  // ServiceProviderConfig(无 organization_id 前缀,RFC7644 4)
  app.get('/scim/v2/ServiceProviderConfig', (c) =>
    c.json(SERVICE_PROVIDER_CONFIG, 200, { 'Content-Type': 'application/scim+json' }),
  )

  // Schemas
  app.get('/scim/v2/Schemas', (c) =>
    c.json(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: SCIM_SCHEMAS.length,
        Resources: SCIM_SCHEMAS,
      },
      200,
      { 'Content-Type': 'application/scim+json' },
    ),
  )

  // ResourceTypes
  app.get('/scim/v2/ResourceTypes', (c) =>
    c.json(
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: SCIM_RESOURCE_TYPES.length,
        Resources: SCIM_RESOURCE_TYPES,
      },
      200,
      { 'Content-Type': 'application/scim+json' },
    ),
  )

  // Users、Groups、Bulk 路由(含 organization_id 路径参数)
  registerScimUsersRoutes(app, SCIM_BASE)
  registerScimGroupsRoutes(app, SCIM_BASE)
  registerScimBulkRoutes(app, SCIM_BASE)
  // Outbound SCIM client:XID -> downstream SaaS SCIM target。
  registerOutboundScimRoutes(app)
}

export { authBearer } from './shared'
