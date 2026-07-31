// @xid-kit/electron -- ./renderer entry point.
// All exports here are safe to use in the Electron renderer process.
// This file does NOT import any Node.js or Electron main-process APIs.

export { getIpcStorageAdapter, getXidBridge } from './ipc-storage'

// Re-export @xid-kit/core types that renderer code needs directly.
export {
  XidClient,
  XidStore,
  XidNetworkError,
  makeXidError,
  isXidErrorShape,
  decodeTokenClaims,
  isTokenExpiring,
  SESSION_STATUS,
  CLIENT_STATUS,
} from '@xid-kit/core'

export type {
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

export type { OrganizationMembershipRole } from '@xid-kit/types'

export type { SecureStorageAdapter, XidBridge, SignInOptions, IpcChannels } from '../types'

export { IPC_CHANNELS, XID_BRIDGE_KEY } from '../types'
