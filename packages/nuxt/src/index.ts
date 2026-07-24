// @xid-kit/nuxt: Nuxt 3 integration layer.
// Main entry: exports the Nuxt module default (loaded by 'modules: ["@xid-kit/nuxt"]'),
// server middleware helpers, composables, and core re-exports.

// --- Nuxt Module (default export for modules: ['@xid-kit/nuxt']) ---
export { defineXidModule, setupXidModule, moduleMetadata } from './module'
export type { XidNuxtModuleOptions } from './types'

// Default export consumed by Nuxt's module loader.
// modules: ['@xid-kit/nuxt'] -> Nuxt imports this file and calls the default export.
export { default } from './module'

// --- Server Middleware ---
export { createXidServerMiddleware, getXidAuth } from './server-middleware'
export type { XidServerMiddlewareOptions } from './server-middleware'

// --- Auth Types ---
export type { AuthResult, AuthObject, UnauthenticatedAuthObject } from './types'
export { XID_AUTH_CONTEXT_KEY } from './types'

// --- Composables (re-export @xid-kit/vue) ---
// Nuxt auto-imports are registered by the module's addImports; these named exports
// are for consumers who prefer explicit imports.
export { useXid, useAuth, useUser, useOrganization, useSession } from '@xid-kit/vue'

export type {
  UseXidReturn,
  UseAuthReturn,
  UseUserReturn,
  UseOrganizationReturn,
  UseSessionReturn,
} from '@xid-kit/vue'

// --- Core re-exports ---
export {
  XidClient,
  XidStore,
  TokenManager,
  XidApiClient,
  XidNetworkError,
  makeXidError,
  isXidErrorShape,
  decodeTokenClaims,
  isTokenExpiring,
  SESSION_STATUS,
  CLIENT_STATUS,
  PACKAGE,
} from '@xid-kit/core'

// createXidClient from @xid-kit/vue (wraps XidClient constructor)
export { createXidClient } from '@xid-kit/vue'

export type {
  TokenResponse,
  ClientStateResponse,
  DecodedTokenClaims,
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidApiKey,
  XidApiKeyWithSecret,
  XidPage,
  CreateApiKeyInput,
  SignInPasswordInput,
  SignInResult,
  SessionStatus,
  ClientStatus,
  XidState,
  XidStateListener,
  Unsubscribe,
  GetTokenOptions,
  XidClientOptions,
} from '@xid-kit/core'
